package replay

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestPublicEventIsAnAllowList(t *testing.T) {
	kept := map[string]string{
		`{"type":0,"timestamp":1,"data":{}}`:                                               "",
		`{"type":1,"timestamp":1,"data":{}}`:                                               "",
		`{"type":2,"timestamp":2,"data":{"node":{"type":0,"id":1}}}`:                       "",
		`{"type":3,"timestamp":3,"data":{"source":2,"type":2,"id":7}}`:                     "",
		`{"type":4,"timestamp":4,"data":{"href":"https://a.dev/","width":10,"height":10}}`: "",
		`{"type":5,"timestamp":5,"data":{"tag":"navigate","payload":{"href":"https://a.dev/x","path":"/x","title":"X","secret":"no","user":{"email":"ada@x.dev"}}}}`: `{"type":5,"timestamp":5,"data":{"tag":"navigate","payload":{"href":"https://a.dev/x","path":"/x","title":"X"}}}`,
	}
	for in, want := range kept {
		got, ok := PublicEvent([]byte(in))
		if !ok {
			t.Errorf("dropped %s", in)
			continue
		}
		if want == "" {
			want = in
		}
		if string(got) != want {
			t.Errorf("PublicEvent(%s) = %s, want %s", in, got, want)
		}
	}
	for _, in := range []string{
		`{"type":5,"timestamp":1,"data":{"tag":"console","payload":{"level":"log","text":"token abc"}}}`,
		`{"type":5,"timestamp":1,"data":{"tag":"network","payload":{"method":"GET","url":"https://api.a.dev/me","status":200,"responseBody":"{}"}}}`,
		`{"type":5,"timestamp":1,"data":{"tag":"error","payload":{"message":"boom","stack":"at pay"}}}`,
		`{"type":5,"timestamp":1,"data":{"tag":"rage-click","payload":{"selector":"button","text":"Buy"}}}`,
		`{"type":5,"timestamp":1,"data":{"tag":"dead-click","payload":{"selector":"button"}}}`,
		`{"type":5,"timestamp":1,"data":{"tag":"identify","payload":{"id":"user-42","email":"ada@x.dev","name":"Ada"}}}`,
		`{"type":5,"timestamp":1,"data":{"tag":"track","payload":{"name":"signup","props":{"plan":"pro"}}}}`,
		`{"type":5,"timestamp":1,"data":{"tag":"something-new","payload":{}}}`,
		`{"type":6,"timestamp":1,"data":{"plugin":"rrweb/console@1","payload":{"payload":["secret"]}}}`,
		`{"type":7,"timestamp":1,"data":{}}`,
		`{"timestamp":1}`,
		`"text"`,
		`{"type":"5"}`,
	} {
		if got, ok := PublicEvent([]byte(in)); ok {
			t.Errorf("kept %s as %s", in, got)
		}
	}
}

func TestArrayWriterFiltersSealedArraysToo(t *testing.T) {
	var out bytes.Buffer
	aw := &ArrayWriter{W: &out, Filter: PublicEvent}
	if err := aw.WriteArray([]byte(`[{"type":4,"timestamp":1,"data":{"href":"https://a.dev/"}},
		{"type":5,"timestamp":2,"data":{"tag":"console","payload":{"text":"hidden"}}},
		{"type":5,"timestamp":3,"data":{"tag":"identify","payload":{"email":"ada@x.dev"}}}]`)); err != nil {
		t.Fatal(err)
	}
	if err := aw.WriteElement([]byte(`{"type":5,"timestamp":4,"data":{"tag":"network","payload":{"url":"https://api.a.dev"}}}`)); err != nil {
		t.Fatal(err)
	}
	if err := aw.WriteElement([]byte(`{"type":3,"timestamp":5,"data":{"source":1}}`)); err != nil {
		t.Fatal(err)
	}
	var events []map[string]any
	if err := json.Unmarshal([]byte("["+out.String()+"]"), &events); err != nil {
		t.Fatalf("%v: %s", err, out.String())
	}
	if len(events) != 2 || events[0]["type"] != float64(4) || events[1]["type"] != float64(3) {
		t.Fatalf("events: %s", out.String())
	}
	for _, word := range []string{"hidden", "ada@x.dev", "api.a.dev", "console", "identify", "network"} {
		if strings.Contains(out.String(), word) {
			t.Errorf("%q reached a public link: %s", word, out.String())
		}
	}
}
