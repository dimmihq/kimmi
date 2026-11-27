package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/dimmihq/kimmi/internal/auth"
	"github.com/dimmihq/kimmi/internal/store"
)

const (
	cookieName = "kimmi_session"
	sessionTTL = 30 * 24 * time.Hour
	// touchEvery limits last-seen writes to one per session per minute.
	touchEvery = time.Minute
)

// principal is who is calling: a signed-in user, or a user's API token.
type principal struct {
	user      store.User
	sessionID string          // set for cookie sessions
	token     *store.APIToken // set for API tokens
}

type userHandler func(w http.ResponseWriter, r *http.Request, p *principal)

type projectHandler func(w http.ResponseWriter, r *http.Request, p *principal, proj store.Project)

// user wraps h with authentication and an org role check.
func (a *API) user(min string, h userHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, err := a.authenticate(r)
		if err != nil {
			a.fail(w, r, err)
			return
		}
		if err := p.allow(r, p.user.Role, min); err != nil {
			a.fail(w, r, err)
			return
		}
		h(w, r, p)
	}
}

// project wraps h with authentication, the project lookup and a role check
// against the caller's role in that project. Projects the caller cannot see
// answer 404.
func (a *API) project(min string, h projectHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, err := a.authenticate(r)
		if err != nil {
			a.fail(w, r, err)
			return
		}
		proj, err := a.Store.GetProject(r.Context(), p.user.OrgID, r.PathValue("id"))
		if err != nil {
			a.fail(w, r, err)
			return
		}
		role, err := a.projectRole(r, p, proj.ID)
		if err != nil {
			a.fail(w, r, err)
			return
		}
		if err := p.allow(r, role, min); err != nil {
			a.fail(w, r, err)
			return
		}
		h(w, r, p, proj)
	}
}

// projectRole is the caller's effective role in a project: owners and
// admins have theirs everywhere; members and viewers need a project_members
// row and never rise above their org role.
func (a *API) projectRole(r *http.Request, p *principal, projectID string) (string, error) {
	if auth.AtLeast(p.user.Role, store.RoleAdmin) {
		return p.user.Role, nil
	}
	roles, err := a.Store.ProjectRoles(r.Context(), p.user.ID)
	if err != nil {
		return "", err
	}
	role, ok := roles[projectID]
	if !ok {
		return "", errNotFound
	}
	return auth.Lesser(p.user.Role, role), nil
}

// allow checks a role and, for read-only tokens, the method.
func (p *principal) allow(r *http.Request, role, min string) error {
	if p.token != nil && p.token.Access == "read" && r.Method != http.MethodGet {
		return forbidden("This API token is read-only")
	}
	if !auth.AtLeast(role, min) {
		return forbidden("Your role does not allow this")
	}
	return nil
}

func (a *API) authenticate(r *http.Request) (*principal, error) {
	ctx := r.Context()
	now := time.Now()
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		secret := strings.TrimPrefix(h, "Bearer ")
		t, err := a.Store.GetAPITokenByHash(ctx, auth.HashToken(secret))
		if errors.Is(err, store.ErrNotFound) || (err == nil && t.ExpiresAt != nil && *t.ExpiresAt <= now.UnixMilli()) {
			return nil, errUnauthorized
		}
		if err != nil {
			return nil, err
		}
		u, err := a.Store.GetUser(ctx, t.UserID)
		if err != nil {
			return nil, errUnauthorized
		}
		if t.LastUsedAt == nil || now.Sub(time.UnixMilli(*t.LastUsedAt)) > touchEvery {
			if err := a.Store.TouchAPIToken(ctx, t.ID, now.UnixMilli()); err != nil {
				a.Log.Warn("touch api token", "err", err)
			}
		}
		return &principal{user: u, token: &t}, nil
	}

	c, err := r.Cookie(cookieName)
	if err != nil {
		return nil, errUnauthorized
	}
	secret, ok := a.Signer.Verify(c.Value)
	if !ok {
		return nil, errUnauthorized
	}
	s, err := a.Store.GetAuthSessionByHash(ctx, auth.HashToken(secret))
	if errors.Is(err, store.ErrNotFound) {
		return nil, errUnauthorized
	}
	if err != nil {
		return nil, err
	}
	if now.Sub(time.UnixMilli(s.LastSeenAt)) > sessionTTL {
		return nil, errUnauthorized
	}
	u, err := a.Store.GetUser(ctx, s.UserID)
	if err != nil {
		return nil, errUnauthorized
	}
	if now.Sub(time.UnixMilli(s.LastSeenAt)) > touchEvery {
		if err := a.Store.TouchAuthSession(ctx, s.ID, now.UnixMilli()); err != nil {
			a.Log.Warn("touch auth session", "err", err)
		}
	}
	return &principal{user: u, sessionID: s.ID}, nil
}

// signIn starts a cookie session for u.
func (a *API) signIn(w http.ResponseWriter, r *http.Request, u *store.User) error {
	now := time.Now().UnixMilli()
	secret := auth.NewOpaque()
	s := store.AuthSession{ID: store.NewID(), UserID: u.ID, TokenHash: auth.HashToken(secret),
		UserAgent: r.UserAgent(), IP: a.Proxies.String(r), CreatedAt: now, LastSeenAt: now}
	if err := a.Store.CreateAuthSession(r.Context(), s); err != nil {
		return err
	}
	u.LastLoginAt = &now
	if err := a.Store.UpdateUser(r.Context(), *u); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: a.Signer.Sign(secret), Path: "/", MaxAge: int(sessionTTL.Seconds()),
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: a.Config.Secure(),
	})
	return nil
}

func (a *API) clearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true,
		SameSite: http.SameSiteLaxMode, Secure: a.Config.Secure()})
}
