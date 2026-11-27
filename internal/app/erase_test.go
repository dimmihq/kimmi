package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dimmihq/kimmi/internal/config"
)

func TestErasePrefix(t *testing.T) { erasePrefix(t, testConfig(t)) }

func TestErasePrefixPostgres(t *testing.T) { erasePrefix(t, testConfigWith(t, postgresURL(t))) }

// erasePrefix erases every visitor of a project whose external id starts
// with a prefix, and nothing else.
func erasePrefix(t *testing.T, cfg config.Config) {
	ctx := context.Background()
	a, err := New(ctx, cfg, "test", "abc", quietLog())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	owner := newClient(t, srv.URL)
	owner.do("POST", "/api/v1/auth/signup", obj{"name": "Ada", "email": "ada@acme.dev", "password": "correct horse", "orgName": "Acme"}, 201, nil)
	var shop, other struct{ ID, PublicKey string }
	owner.do("POST", "/api/v1/projects", obj{"name": "Shop", "origin": "https://shop.acme.dev", "platform": "react"}, 201, &shop)
	owner.do("POST", "/api/v1/projects", obj{"name": "Other", "origin": "https://shop.acme.dev", "platform": "react"}, 201, &other)

	start := time.Now().Add(-10 * time.Minute).UnixMilli()
	send := func(key string, i int, ext string) {
		s := makeSession(start+int64(i)*5000, fmt.Sprintf("anon-%d", i), 1)
		s.ext = ext
		postBatch(t, srv.URL, key, s.body(t, 0, start+int64(i)*5000), 204)
	}
	send(shop.PublicKey, 0, "ws_1:u1")
	send(shop.PublicKey, 1, "ws_1:u2")
	send(shop.PublicKey, 2, "ws_12:u1")
	send(shop.PublicKey, 3, "ws%1:u1")
	send(other.PublicKey, 4, "ws_1:u1")
	if err := a.Flusher.Flush(ctx); err != nil {
		t.Fatal(err)
	}

	erase := "/api/v1/projects/" + shop.ID + "/visitors/erase"
	var bad struct {
		Error struct{ Fields map[string]string }
	}
	for _, body := range []obj{{"externalIdPrefix": "w:"}, {"externalIdPrefix": "ws_1"}, {"externalIdPrefix": ""},
		{"externalIdPrefix": "ws_1:", "query": "x"}} {
		owner.do("POST", erase, body, 400, &bad)
		if bad.Error.Fields["externalIdPrefix"] == "" {
			t.Fatalf("%v: fields %v", body, bad.Error.Fields)
		}
	}
	owner.do("POST", erase, obj{}, 400, nil)

	var created struct{ Secret string }
	owner.do("POST", "/api/v1/tokens", obj{"name": "dimmi", "access": "read"}, 201, &created)
	bot := &client{t: t, base: srv.URL, http: http.DefaultClient, auth: created.Secret}
	bot.do("POST", erase, obj{"externalIdPrefix": "ws_1:"}, 403, nil)
	owner.do("POST", "/api/v1/tokens", obj{"name": "dimmi", "access": "write"}, 201, &created)
	bot.auth = created.Secret

	var res struct{ Deleted int }
	owner.do("POST", erase, obj{"externalIdPrefix": "ws%:"}, 200, &res)
	if res.Deleted != 0 {
		t.Fatalf("a %% in the prefix matched %d visitors", res.Deleted)
	}
	bot.do("POST", erase, obj{"externalIdPrefix": "ws_1:"}, 200, &res)
	if res.Deleted != 2 {
		t.Fatalf("deleted %d", res.Deleted)
	}
	bot.do("POST", erase, obj{"externalIdPrefix": "ws_1:"}, 200, &res)
	if res.Deleted != 0 {
		t.Fatalf("second erase deleted %d", res.Deleted)
	}

	var list struct {
		Total int
		Items []struct{ Visitor struct{ ExternalID *string } }
	}
	owner.do("GET", "/api/v1/projects/"+shop.ID+"/recordings", nil, 200, &list)
	if list.Total != 2 {
		t.Fatalf("recordings left in the project: %d", list.Total)
	}
	for _, r := range list.Items {
		if id := r.Visitor.ExternalID; id == nil || (*id != "ws_12:u1" && *id != "ws%1:u1") {
			t.Fatalf("left %v", id)
		}
	}
	owner.do("GET", "/api/v1/projects/"+other.ID+"/recordings", nil, 200, &list)
	if list.Total != 1 {
		t.Fatalf("recordings left in the other project: %d", list.Total)
	}
	var visitors struct{ Total int }
	owner.do("GET", "/api/v1/projects/"+shop.ID+"/visitors", nil, 200, &visitors)
	if visitors.Total != 2 {
		t.Fatalf("visitors left: %d", visitors.Total)
	}
}
