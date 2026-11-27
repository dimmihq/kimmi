package settings

import (
	"encoding/json"
	"testing"
)

func TestMergeIsDeep(t *testing.T) {
	s := Default()
	got, fields, err := s.Merge(json.RawMessage(`{"capture":{"sampleRate":25,"urlRules":[{"type":"contains","pattern":"/checkout"}]},"retention":{"days":90}}`))
	if err != nil || fields != nil {
		t.Fatal(err, fields)
	}
	if got.Capture.SampleRate != 25 || !got.Capture.Console || got.Retention.Days != 90 || !got.Retention.KeepStarred ||
		len(got.Capture.URLRules) != 1 || !got.Privacy.MaskAllInputs {
		t.Fatalf("merged %+v", got)
	}
}

func TestMergeValidates(t *testing.T) {
	_, fields, err := Default().Merge(json.RawMessage(`{"retention":{"days":12},"capture":{"sampleRate":101},"privacy":{"ip":"some"}}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"retention.days", "capture.sampleRate", "privacy.ip"} {
		if fields[k] == "" {
			t.Errorf("no error for %s: %v", k, fields)
		}
	}
	if _, _, err := Default().Merge(json.RawMessage(`{"capture":{"sampleRate":"all"}}`)); err == nil {
		t.Fatal("wrong type accepted")
	}
	if _, _, err := Default().Merge(json.RawMessage(`[1]`)); err == nil {
		t.Fatal("array accepted")
	}
}

func TestDecodeFillsGaps(t *testing.T) {
	s := Decode([]byte(`{"capture":{"sampleRate":10}}`), 7, false)
	if s.Capture.SampleRate != 10 || s.Capture.IdleTimeoutMs != 900000 || s.Privacy.IP != "truncate" ||
		s.Retention != (Retention{7, false}) || s.Privacy.MaskSelectors == nil {
		t.Fatalf("decoded %+v", s)
	}
	round := Decode(s.Encode(), 7, false)
	if round.Capture.SampleRate != 10 {
		t.Fatal("encode lost data")
	}
}

func TestScrubDefaults(t *testing.T) {
	if d := Default(); !d.Privacy.ScrubEmails || !d.Privacy.ScrubPhones {
		t.Fatal("scrubbing must default on")
	}
	// Settings stored before the fields existed read as true.
	old := Decode([]byte(`{"privacy":{"maskAllText":true,"ip":"none"}}`), 30, true)
	if !old.Privacy.ScrubEmails || !old.Privacy.ScrubPhones || !old.Privacy.MaskAllText {
		t.Fatalf("old settings %+v", old.Privacy)
	}
	off, fields, err := old.Merge(json.RawMessage(`{"privacy":{"scrubPhones":false}}`))
	if err != nil || fields != nil || !off.Privacy.ScrubEmails || off.Privacy.ScrubPhones {
		t.Fatalf("merge %+v %v %v", off.Privacy, fields, err)
	}
	again := Decode(off.Encode(), 30, true)
	if again.Privacy.ScrubPhones || !again.Privacy.ScrubEmails {
		t.Fatal("a stored false did not survive")
	}
	var body map[string]map[string]any
	json.Unmarshal(off.Encode(), &body)
	if body["privacy"]["scrubEmails"] != true || body["privacy"]["scrubPhones"] != false {
		t.Fatalf("encoded %v", body["privacy"])
	}
}
