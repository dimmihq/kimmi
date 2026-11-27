// Package auth holds kimmi's credentials logic: password hashing, random
// secrets stored as hashes, signed session cookies and role ranks.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"

	"golang.org/x/crypto/bcrypt"

	"github.com/dimmihq/kimmi/internal/store"
)

// MinPasswordLength is the shortest password accepted.
const MinPasswordLength = 8

// Prefixes of generated secrets.
const (
	PublicKeyPrefix = "km_pub_"
	TokenPrefix     = "km_sec_"
)

// ErrWeakPassword rejects passwords that are too short (or too long for bcrypt).
var ErrWeakPassword = errors.New("password must be 8 to 72 characters")

// HashPassword returns a bcrypt hash.
func HashPassword(password string) (string, error) {
	if len(password) < MinPasswordLength || len(password) > 72 {
		return "", ErrWeakPassword
	}
	h, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return string(h), nil
}

var dummy = sync.OnceValue(func() string {
	h, _ := bcrypt.GenerateFromPassword([]byte("kimmi-no-such-user-"+randomHex(8)), bcrypt.DefaultCost)
	return string(h)
})

// DummyHash is a bcrypt hash of no one's password, at the cost real hashes
// use: comparing against it takes as long as a real check and never matches.
func DummyHash() string { return dummy() }

// CheckPassword reports whether password matches hash.
func CheckPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b) // crypto/rand.Read never fails
	return hex.EncodeToString(b)
}

// NewPublicKey returns a project key: km_pub_ and 16 hex characters.
func NewPublicKey() string { return PublicKeyPrefix + randomHex(8) }

// NewToken returns an API token secret.
func NewToken() string { return TokenPrefix + randomHex(24) }

// TokenDisplayPrefix is the part of a token shown in lists.
func TokenDisplayPrefix(secret string) string { return secret[:len(TokenPrefix)+6] }

// NewOpaque returns a random secret for cookies and invitation links.
func NewOpaque() string { return randomHex(32) }

// HashToken is how secrets are stored. They are long and random, so a plain
// SHA-256 is enough; no salt or slow hash is needed.
func HashToken(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// Signer signs cookie values with KIMMI_SECRET.
type Signer struct{ key []byte }

// NewSigner returns a Signer for secret.
func NewSigner(secret string) Signer { return Signer{key: []byte(secret)} }

func (s Signer) mac(v string) string {
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte(v))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// Sign returns v with its signature.
func (s Signer) Sign(v string) string { return v + "." + s.mac(v) }

// Derive returns a secret that only the holder of the key can compute from
// v. Invitation links use it, so a link can be shown again without the
// database keeping it in the clear.
func (s Signer) Derive(v string) string { return s.mac("derive:" + v) }

// Verify returns the value of a signed string.
func (s Signer) Verify(signed string) (string, bool) {
	v, sig, ok := strings.Cut(signed, ".")
	if !ok || !hmac.Equal([]byte(sig), []byte(s.mac(v))) {
		return "", false
	}
	return v, true
}

var rank = map[string]int{store.RoleViewer: 1, store.RoleMember: 2, store.RoleAdmin: 3, store.RoleOwner: 4}

// ValidRole reports whether r is a role name.
func ValidRole(r string) bool { return rank[r] > 0 }

// AtLeast reports whether role is min or more powerful.
func AtLeast(role, min string) bool { return rank[role] >= rank[min] && rank[role] > 0 }

// Lesser returns the less powerful of two roles.
func Lesser(a, b string) string {
	if rank[a] <= rank[b] {
		return a
	}
	return b
}
