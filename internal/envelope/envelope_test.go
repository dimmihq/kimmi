package envelope

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"testing"
)

func gz(t *testing.T, s string) []byte {
	t.Helper()
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	w.Write([]byte(s))
	w.Close()
	return b.Bytes()
}

func validMeta() Meta {
	return Meta{V: 1, SessionID: "s1", AnonymousID: "a1", Seq: 3, StartedAt: 10, FirstTs: 10, LastTs: 20,
		Path: "/checkout", Identity: &Identity{ID: "user-42", Email: "a@b.c"}, Counts: Counts{Clicks: 2}}
}

func TestRoundTrip(t *testing.T) {
	payload := gz(t, `[{"type":4,"timestamp":10,"data":{}}]`)
	body, err := Encode(validMeta(), payload)
	if err != nil {
		t.Fatal(err)
	}
	m, got, err := Parse(body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("payload changed")
	}
	if m.SessionID != "s1" || m.Seq != 3 || m.Identity.ID != "user-42" || m.Counts.Clicks != 2 || m.Path != "/checkout" {
		t.Fatalf("meta = %+v", m)
	}
}

func TestRejects(t *testing.T) {
	payload := gz(t, `[]`)
	withMeta := func(edit func(*Meta)) []byte {
		m := validMeta()
		edit(&m)
		b, _ := Encode(m, payload)
		return b
	}
	huge := make([]byte, 8)
	binary.BigEndian.PutUint32(huge, 1<<30)
	notJSON := append(binary.BigEndian.AppendUint32(nil, 3), []byte("{{{")...)
	notJSON = append(notJSON, payload...)
	plain, _ := Encode(validMeta(), []byte(`[{"type":4},{"type":2},{"type":3}]`))

	cases := map[string][]byte{
		"empty":           nil,
		"length too big":  huge,
		"metadata broken": notJSON,
		"not gzip":        plain,
		"no session":      withMeta(func(m *Meta) { m.SessionID = "" }),
		"no anonymous id": withMeta(func(m *Meta) { m.AnonymousID = "" }),
		"wrong version":   withMeta(func(m *Meta) { m.V = 2 }),
		"negative seq":    withMeta(func(m *Meta) { m.Seq = -1 }),
		"times reversed":  withMeta(func(m *Meta) { m.LastTs = 1 }),
	}
	for name, body := range cases {
		if _, _, err := Parse(body); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s: err = %v, want ErrMalformed", name, err)
		}
	}
}

func TestDefaultsPath(t *testing.T) {
	m := validMeta()
	m.Path = ""
	body, _ := Encode(m, gz(t, `[]`))
	got, _, err := Parse(body)
	if err != nil || got.Path != "/" {
		t.Fatalf("path = %q, err = %v", got.Path, err)
	}
}
