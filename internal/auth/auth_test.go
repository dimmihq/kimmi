package auth

import (
	"regexp"
	"strings"
	"testing"
)

func TestPasswords(t *testing.T) {
	if _, err := HashPassword("short"); err != ErrWeakPassword {
		t.Fatalf("short password: %v", err)
	}
	h, err := HashPassword("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if !CheckPassword(h, "correct horse") || CheckPassword(h, "wrong horse!") {
		t.Fatal("password check")
	}
}

func TestSecrets(t *testing.T) {
	if k := NewPublicKey(); !regexp.MustCompile(`^km_pub_[0-9a-f]{16}$`).MatchString(k) {
		t.Fatalf("public key %q", k)
	}
	tok := NewToken()
	if !strings.HasPrefix(tok, "km_sec_") || len(tok) != 55 || TokenDisplayPrefix(tok) != tok[:13] {
		t.Fatalf("token %q", tok)
	}
	if HashToken(tok) == HashToken(NewToken()) || len(HashToken(tok)) != 64 {
		t.Fatal("token hash")
	}
}

func TestSigner(t *testing.T) {
	s := NewSigner(strings.Repeat("k", 32))
	signed := s.Sign("abc")
	if v, ok := s.Verify(signed); !ok || v != "abc" {
		t.Fatalf("verify %q: %q %v", signed, v, ok)
	}
	for _, bad := range []string{"abc", "abc.", "abd." + strings.SplitN(signed, ".", 2)[1], ""} {
		if _, ok := s.Verify(bad); ok {
			t.Fatalf("accepted %q", bad)
		}
	}
	if _, ok := NewSigner(strings.Repeat("x", 32)).Verify(signed); ok {
		t.Fatal("accepted another key's signature")
	}
}

func TestRoles(t *testing.T) {
	cases := []struct {
		role, min string
		want      bool
	}{
		{"owner", "admin", true}, {"admin", "admin", true}, {"member", "admin", false},
		{"viewer", "member", false}, {"member", "viewer", true}, {"bogus", "viewer", false},
	}
	for _, c := range cases {
		if AtLeast(c.role, c.min) != c.want {
			t.Errorf("AtLeast(%s, %s) != %v", c.role, c.min, c.want)
		}
	}
	if Lesser("owner", "viewer") != "viewer" || Lesser("member", "admin") != "member" {
		t.Fatal("Lesser")
	}
	if !ValidRole("viewer") || ValidRole("root") {
		t.Fatal("ValidRole")
	}
}
