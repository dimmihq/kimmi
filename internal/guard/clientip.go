package guard

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// Proxies resolves the address of the client behind trusted reverse
// proxies. X-Forwarded-For is believed only when the direct peer is in
// Trusted; then the header is read from the right, skipping trusted hops,
// and the first untrusted address is the client. With no trusted proxies
// the socket address is always used, so a client cannot pick its own.
type Proxies struct {
	Trusted []netip.Prefix
}

func (p Proxies) trusted(a netip.Addr) bool {
	for _, t := range p.Trusted {
		if t.Contains(a) {
			return true
		}
	}
	return false
}

// ClientIP returns the client address of r.
func (p Proxies) ClientIP(r *http.Request) netip.Addr {
	peer := peerAddr(r.RemoteAddr)
	if !peer.IsValid() || len(p.Trusted) == 0 || !p.trusted(peer) {
		return peer
	}
	var hops []string
	for _, v := range r.Header.Values("X-Forwarded-For") {
		hops = append(hops, strings.Split(v, ",")...)
	}
	client := peer
	for i := len(hops) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			break // a garbled hop: trust nothing to its left
		}
		client = a.Unmap()
		if !p.trusted(client) {
			break
		}
	}
	return client
}

func peerAddr(remote string) netip.Addr {
	if ap, err := netip.ParseAddrPort(remote); err == nil {
		return ap.Addr().Unmap()
	}
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return a.Unmap()
}

// String is ClientIP as text ("" when unknown).
func (p Proxies) String(r *http.Request) string {
	a := p.ClientIP(r)
	if !a.IsValid() {
		return ""
	}
	return a.String()
}

// LimitKey is the address a rate limit counts against: the address itself
// for IPv4, its /64 network for IPv6, where one host usually holds a whole
// /64.
func (p Proxies) LimitKey(r *http.Request) string {
	a := p.ClientIP(r)
	if !a.IsValid() {
		return "unknown"
	}
	if a.Is6() {
		pre, _ := a.Prefix(64)
		return pre.String()
	}
	return a.String()
}
