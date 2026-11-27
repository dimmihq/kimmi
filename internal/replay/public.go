package replay

import "encoding/json"

// rrweb event types.
const (
	typeDOMContentLoaded = 0
	typeLoad             = 1
	typeFullSnapshot     = 2
	typeIncremental      = 3
	typeMeta             = 4
	typeCustom           = 5
)

// PublicEvent is the ArrayWriter filter of a public link: what someone
// without an account may receive of a recording. It is an allow-list. The
// events rrweb needs to play the page pass as they are; of kimmi's own
// events only `navigate` passes, rebuilt from the three fields the public
// page shows. Console, network, error, rage-click, dead-click, identify and
// track events, plugin events and anything unknown are left out.
func PublicEvent(e []byte) ([]byte, bool) {
	var head struct {
		Type      *int  `json:"type"`
		Timestamp int64 `json:"timestamp"`
	}
	if json.Unmarshal(e, &head) != nil || head.Type == nil {
		return nil, false
	}
	switch *head.Type {
	case typeDOMContentLoaded, typeLoad, typeFullSnapshot, typeIncremental, typeMeta:
		return e, true
	case typeCustom:
		var custom struct {
			Data struct {
				Tag     string `json:"tag"`
				Payload struct {
					Href  string `json:"href"`
					Path  string `json:"path"`
					Title string `json:"title"`
				} `json:"payload"`
			} `json:"data"`
		}
		if json.Unmarshal(e, &custom) != nil || custom.Data.Tag != "navigate" {
			return nil, false
		}
		type payload struct {
			Href  string `json:"href"`
			Path  string `json:"path"`
			Title string `json:"title"`
		}
		type data struct {
			Tag     string  `json:"tag"`
			Payload payload `json:"payload"`
		}
		out, err := json.Marshal(struct {
			Type      int   `json:"type"`
			Timestamp int64 `json:"timestamp"`
			Data      data  `json:"data"`
		}{typeCustom, head.Timestamp, data{"navigate", payload(custom.Data.Payload)}})
		return out, err == nil
	}
	return nil, false
}
