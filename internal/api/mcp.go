package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/dimmihq/kimmi/internal/store"
)

// The MCP endpoint lets an AI assistant read a workspace with an API token:
// POST /mcp speaks the Model Context Protocol's streamable HTTP transport,
// answering each JSON-RPC request with one JSON response. It only reads.

const mcpProtocol = "2025-06-18"

var mcpVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type mcpTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	// project says the tool takes a project and days.
	project bool
	run     func(a *API, r *http.Request, p *principal, proj store.Project, args map[string]any) (any, error)
}

func schema(project bool, extra map[string]any) map[string]any {
	props := map[string]any{}
	required := []string{}
	if project {
		props["project"] = map[string]any{"type": "string", "description": "Project id or slug, from list_projects"}
		props["days"] = map[string]any{"type": "integer", "enum": []int{1, 7, 14, 30, 90}, "description": "Window in days, 7 by default"}
		required = append(required, "project")
	}
	for k, v := range extra {
		props[k] = v
	}
	return map[string]any{"type": "object", "properties": props, "required": required}
}

func str(args map[string]any, key string) string {
	s, _ := args[key].(string)
	return s
}

// withQuery returns r with its query replaced by the tool's arguments, so
// tools read their window and filters the way the REST routes do.
func withQuery(r *http.Request, args map[string]any) *http.Request {
	q := url.Values{}
	for k, v := range args {
		switch t := v.(type) {
		case string:
			q.Set(k, t)
		case float64:
			q.Set(k, strconv.Itoa(int(t)))
		case bool:
			if t {
				q.Set(k, "1")
			}
		}
	}
	out := r.Clone(r.Context())
	u := *r.URL
	u.RawQuery = q.Encode()
	out.URL = &u
	return out
}

var mcpTools = []mcpTool{
	{Name: "list_projects", Description: "List the projects (recorded sites) this token can read.", InputSchema: schema(false, nil),
		run: func(a *API, r *http.Request, p *principal, _ store.Project, _ map[string]any) (any, error) {
			list, err := a.visibleProjects(r, p)
			if err != nil {
				return nil, err
			}
			out := make([]map[string]any, len(list))
			for i, p := range list {
				out[i] = map[string]any{"id": p.ID, "name": p.Name, "slug": p.Slug, "origin": p.Origin, "timezone": p.Timezone}
			}
			return out, nil
		}},
	{Name: "get_traffic", project: true,
		Description: "Visitors, visits, page views, bounces, sources, channels, campaigns, pages, countries, devices and goal conversions of a project.",
		InputSchema: schema(true, map[string]any{"path": map[string]any{"type": "string", "description": "Only visits that viewed this path"},
			"referrer": map[string]any{"type": "string", "description": "Only visits from this source"}}),
		run: func(a *API, r *http.Request, _ *principal, proj store.Project, _ map[string]any) (any, error) {
			return a.trafficView(r, proj)
		}},
	{Name: "list_errors", project: true, Description: "Uncaught errors grouped by kind, most visits affected first.", InputSchema: schema(true, nil),
		run: func(a *API, r *http.Request, _ *principal, proj store.Project, _ map[string]any) (any, error) {
			return a.Store.ErrorGroups(r.Context(), analyticsQuery(r, proj))
		}},
	{Name: "get_error", project: true, Description: "One error group with its latest occurrences and links to their recordings.",
		InputSchema: schema(true, map[string]any{"fingerprint": map[string]any{"type": "string", "description": "From list_errors"}}),
		run: func(a *API, r *http.Request, _ *principal, proj store.Project, args map[string]any) (any, error) {
			g, occurrences, err := a.Store.ErrorGroup(r.Context(), analyticsQuery(r, proj), str(args, "fingerprint"))
			if err != nil {
				return nil, err
			}
			links := make([]map[string]any, 0, len(occurrences))
			for _, o := range occurrences {
				row := map[string]any{"at": o.Ts, "path": o.Path, "browser": o.Browser, "os": o.OS, "release": o.Release}
				if o.Recorded {
					row["recording"] = a.recordingLink(proj.ID, o.VisitID, o.Ts-o.StartedAt)
				}
				links = append(links, row)
			}
			return map[string]any{"group": g, "occurrences": links}, nil
		}},
	{Name: "get_friction", project: true, Description: "Pages and elements where visitors rage-click, dead-click or hit errors.", InputSchema: schema(true, nil),
		run: func(a *API, r *http.Request, _ *principal, proj store.Project, _ map[string]any) (any, error) {
			return a.Store.Friction(r.Context(), analyticsQuery(r, proj))
		}},
	{Name: "list_funnels", project: true, Description: "The project's funnels with how many visits reached each step.", InputSchema: schema(true, nil),
		run: func(a *API, r *http.Request, _ *principal, proj store.Project, _ map[string]any) (any, error) {
			out := []funnelView{}
			for _, f := range projectSettings(proj).Analytics.Funnels {
				view, _, err := a.runFunnel(r, proj, f)
				if err != nil {
					return nil, err
				}
				out = append(out, view)
			}
			return out, nil
		}},
	{Name: "list_events", project: true, Description: "Tracked events (kimmi.track and automatic ones) with counts.", InputSchema: schema(true, nil),
		run: func(a *API, r *http.Request, _ *principal, proj store.Project, _ map[string]any) (any, error) {
			return a.Store.EventNames(r.Context(), analyticsQuery(r, proj))
		}},
	{Name: "get_performance", project: true, Description: "Web vitals per page (75th percentile) and failing or slow requests.", InputSchema: schema(true, nil),
		run: func(a *API, r *http.Request, _ *principal, proj store.Project, _ map[string]any) (any, error) {
			q := analyticsQuery(r, proj)
			vitals, err := a.Store.Vitals(r.Context(), q)
			if err != nil {
				return nil, err
			}
			requests, err := a.Store.Requests(r.Context(), q)
			return map[string]any{"vitals": vitals, "requests": requests}, err
		}},
	{Name: "list_recordings", project: true,
		Description: "Recordings with links to watch them. sort=score puts the ones most worth watching first.",
		InputSchema: schema(true, map[string]any{
			"view":  map[string]any{"type": "string", "enum": []string{"all", "unwatched", "friction", "starred"}},
			"sort":  map[string]any{"type": "string", "enum": []string{"score"}},
			"path":  map[string]any{"type": "string", "description": "Recordings that visited this path"},
			"event": map[string]any{"type": "string", "description": "kind:name, for example error:<fingerprint>, rage:<selector> or track:<name>"},
			"limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 50}}),
		run: func(a *API, r *http.Request, _ *principal, proj store.Project, args map[string]any) (any, error) {
			q := store.RecordingQuery{ProjectID: proj.ID, View: str(args, "view"), Limit: intParam(r, "limit", 10, 1, 50)}
			recordingFilters(r, &q)
			page, err := a.Store.ListRecordings(r.Context(), q)
			if err != nil {
				return nil, err
			}
			out := make([]map[string]any, len(page.Items))
			for i, rec := range page.Items {
				out[i] = map[string]any{"id": rec.ID, "url": a.recordingLink(proj.ID, rec.ID, 0), "startedAt": rec.StartedAt,
					"durationMs": rec.DurationMs, "pages": rec.Pages, "entry": rec.EntryPath, "exit": rec.ExitPath, "errors": rec.Errors,
					"rageClicks": rec.RageClicks, "deadClicks": rec.DeadClicks, "device": rec.Device, "browser": rec.Browser, "seen": rec.Seen}
			}
			return map[string]any{"total": page.Total, "items": out}, nil
		}},
	{Name: "list_feedback", project: true, Description: "Messages visitors sent with the feedback button, newest first.", InputSchema: schema(true, nil),
		run: func(a *API, r *http.Request, _ *principal, proj store.Project, _ map[string]any) (any, error) {
			return a.Store.ListFeedback(r.Context(), proj.ID, 0, 25)
		}},
}

func (a *API) recordingLink(projectID, recordingID string, atMs int64) string {
	link := strings.TrimRight(a.Config.PublicURL, "/") + "/projects/" + projectID + "/recordings/" + recordingID
	if atMs > 0 {
		link += "?t=" + strconv.FormatInt(atMs/1000, 10)
	}
	return link
}

func (a *API) mcpRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /mcp", a.mcp)
	m.HandleFunc("GET /mcp", func(w http.ResponseWriter, _ *http.Request) {
		// No server-initiated stream is offered.
		w.Header().Set("Allow", "POST")
		w.WriteHeader(http.StatusMethodNotAllowed)
	})
}

func (a *API) mcp(w http.ResponseWriter, r *http.Request) {
	p, err := a.authenticate(r)
	if err != nil {
		w.Header().Set("WWW-Authenticate", `Bearer realm="kimmi"`)
		a.fail(w, r, err)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	var req rpcRequest
	if err != nil || json.Unmarshal(body, &req) != nil || req.JSONRPC != "2.0" || req.Method == "" {
		writeJSON(w, http.StatusBadRequest, rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"),
			Error: &rpcError{Code: -32700, Message: "Send one JSON-RPC 2.0 request"}})
		return
	}
	if len(req.ID) == 0 { // a notification: nothing to answer
		w.WriteHeader(http.StatusAccepted)
		return
	}
	res := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	switch req.Method {
	case "initialize":
		var in struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &in)
		version := mcpProtocol
		for _, v := range mcpVersions {
			if v == in.ProtocolVersion {
				version = v
			}
		}
		res.Result = map[string]any{"protocolVersion": version, "capabilities": map[string]any{"tools": map[string]any{}},
			"serverInfo":   map[string]any{"name": "kimmi", "version": a.Version},
			"instructions": "Read-only access to a kimmi workspace: traffic, errors, friction, funnels and recordings. Start with list_projects."}
	case "ping":
		res.Result = map[string]any{}
	case "tools/list":
		res.Result = map[string]any{"tools": mcpTools}
	case "tools/call":
		res.Result, res.Error = a.mcpCall(r, p, req.Params)
	default:
		res.Error = &rpcError{Code: -32601, Message: "Unknown method " + req.Method}
	}
	writeJSON(w, http.StatusOK, res)
}

// mcpCall runs one tool. A failure the caller can fix is a tool result
// with isError, as the protocol asks; only a malformed call is an error.
func (a *API) mcpCall(r *http.Request, p *principal, params json.RawMessage) (any, *rpcError) {
	var in struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return nil, &rpcError{Code: -32602, Message: "tools/call needs a name and arguments"}
	}
	for _, tool := range mcpTools {
		if tool.Name != in.Name {
			continue
		}
		var proj store.Project
		if tool.project {
			list, err := a.visibleProjects(r, p)
			if err != nil {
				return toolError(err), nil
			}
			want, found := str(in.Arguments, "project"), false
			for _, candidate := range list {
				if candidate.ID == want || candidate.Slug == want {
					proj, found = candidate, true
				}
			}
			if !found {
				return toolError(invalid("No such project; call list_projects for the ids", nil)), nil
			}
		}
		started := time.Now()
		out, err := tool.run(a, withQuery(r, in.Arguments), p, proj, in.Arguments)
		if err != nil {
			return toolError(err), nil
		}
		text, err := json.Marshal(out)
		if err != nil {
			return toolError(err), nil
		}
		a.Log.Info("mcp", "tool", tool.Name, "ms", time.Since(started).Milliseconds())
		return map[string]any{"content": []map[string]any{{"type": "text", "text": string(text)}}}, nil
	}
	return nil, &rpcError{Code: -32602, Message: "Unknown tool " + in.Name}
}

func toolError(err error) map[string]any {
	msg := "Something went wrong on the server"
	var e *apiError
	switch {
	case errors.As(err, &e):
		msg = e.msg
	case errors.Is(err, store.ErrNotFound):
		msg = "Not found"
	}
	return map[string]any{"isError": true, "content": []map[string]any{{"type": "text", "text": msg}}}
}
