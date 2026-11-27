package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/dimmihq/kimmi/internal/auth"
	"github.com/dimmihq/kimmi/internal/store"
	"github.com/dimmihq/kimmi/internal/useragent"
)

type meResponse struct {
	User store.User `json:"user"`
	Org  store.Org  `json:"org"`
}

func (a *API) meBody(r *http.Request, u store.User) (meResponse, error) {
	org, err := a.Store.GetOrg(r.Context(), u.OrgID)
	return meResponse{User: u, Org: org}, err
}

// claimed reports whether the instance already belongs to someone: it has
// users, or, with closed sign-ups, an organisation (one bootstrapped at
// start-up waits for its owner and must not go to the first visitor).
func (a *API) claimed(r *http.Request) (bool, error) {
	has, err := a.Store.HasUsers(r.Context())
	if err != nil || has || a.Config.Signups != "closed" {
		return has, err
	}
	_, err = a.Store.FirstOrg(r.Context())
	if errors.Is(err, store.ErrNotFound) {
		return false, nil
	}
	return err == nil, err
}

func (a *API) authStatus(w http.ResponseWriter, r *http.Request) {
	has, err := a.claimed(r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"signups": a.Config.Signups, "hasUsers": has})
}

// checkAccount validates the fields shared by signup and invitation accept.
func checkAccount(name, email, password string, fields map[string]string) {
	if strings.TrimSpace(name) == "" {
		fields["name"] = "Required"
	}
	if email != "" {
		if a, err := mail.ParseAddress(email); err != nil || a.Address != email {
			fields["email"] = "Not a valid email address"
		}
	}
	if len(password) < auth.MinPasswordLength {
		fields["password"] = "At least 8 characters"
	} else if len(password) > 72 {
		fields["password"] = "At most 72 characters"
	}
}

func (a *API) signup(w http.ResponseWriter, r *http.Request) {
	var in struct{ Name, Email, Password, OrgName string }
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	fields := map[string]string{}
	if in.Email == "" {
		fields["email"] = "Required"
	}
	checkAccount(in.Name, in.Email, in.Password, fields)
	if len(fields) > 0 {
		a.fail(w, r, invalid("Check the highlighted fields", fields))
		return
	}
	if a.Config.Signups == "closed" {
		has, err := a.claimed(r)
		if err != nil {
			a.fail(w, r, err)
			return
		}
		if has {
			a.fail(w, r, forbidden("Sign-ups are closed on this instance; ask an admin for an invitation"))
			return
		}
	}
	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	now := time.Now().UnixMilli()
	orgName := strings.TrimSpace(in.OrgName)
	if orgName == "" {
		orgName = strings.TrimSpace(in.Name) + "'s workspace"
	}
	org := store.Org{ID: store.NewID(), Name: orgName, CreatedAt: now}
	u := store.User{ID: store.NewID(), OrgID: org.ID, Name: strings.TrimSpace(in.Name), Email: in.Email,
		PasswordHash: hash, Role: store.RoleOwner, CreatedAt: now}
	if err := a.Store.CreateOrgWithOwner(r.Context(), org, u); err != nil {
		if errors.Is(err, store.ErrConflict) {
			err = &apiError{status: http.StatusConflict, code: "conflict", msg: "Email is already in use",
				fields: map[string]string{"email": "Already in use"}}
		}
		a.fail(w, r, err)
		return
	}
	if err := a.signIn(w, r, &u); err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, meResponse{User: u, Org: store.Org{ID: org.ID, Name: org.Name}})
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var in struct{ Email, Password string }
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	u, err := a.Store.GetUserByEmail(r.Context(), strings.TrimSpace(in.Email))
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		a.fail(w, r, err)
		return
	}
	hash := u.PasswordHash
	if err != nil {
		// An unknown email costs the same bcrypt comparison as a known one,
		// so timing does not tell which emails have accounts.
		hash = auth.DummyHash()
	}
	if ok := auth.CheckPassword(hash, in.Password); err != nil || !ok {
		a.fail(w, r, &apiError{status: http.StatusUnauthorized, code: "invalid_credentials", msg: "Email or password is wrong"})
		return
	}
	if err := a.signIn(w, r, &u); err != nil {
		a.fail(w, r, err)
		return
	}
	body, err := a.meBody(r, u)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	if p, err := a.authenticate(r); err == nil && p.sessionID != "" {
		if err := a.Store.DeleteAuthSession(r.Context(), p.user.ID, p.sessionID); err != nil && !errors.Is(err, store.ErrNotFound) {
			a.fail(w, r, err)
			return
		}
	}
	a.clearCookie(w)
	noContent(w)
}

func (a *API) me(w http.ResponseWriter, r *http.Request, p *principal) {
	body, err := a.meBody(r, p.user)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func (a *API) updateMe(w http.ResponseWriter, r *http.Request, p *principal) {
	var in struct{ Name, Email *string }
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	u := p.user
	fields := map[string]string{}
	if in.Name != nil {
		if u.Name = strings.TrimSpace(*in.Name); u.Name == "" {
			fields["name"] = "Required"
		}
	}
	if in.Email != nil {
		u.Email = strings.ToLower(strings.TrimSpace(*in.Email))
		if addr, err := mail.ParseAddress(u.Email); err != nil || addr.Address != u.Email {
			fields["email"] = "Not a valid email address"
		}
	}
	if len(fields) > 0 {
		a.fail(w, r, invalid("Check the highlighted fields", fields))
		return
	}
	if err := a.Store.UpdateUser(r.Context(), u); err != nil {
		if errors.Is(err, store.ErrConflict) {
			err = &apiError{status: http.StatusConflict, code: "conflict", msg: "Email is already in use",
				fields: map[string]string{"email": "Already in use"}}
		}
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (a *API) changePassword(w http.ResponseWriter, r *http.Request, p *principal) {
	var in struct{ Current, Next string }
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	if !auth.CheckPassword(p.user.PasswordHash, in.Current) {
		a.fail(w, r, invalid("The current password is wrong", map[string]string{"current": "Wrong password"}))
		return
	}
	hash, err := auth.HashPassword(in.Next)
	if err != nil {
		a.fail(w, r, invalid("Choose a longer password", map[string]string{"next": "8 to 72 characters"}))
		return
	}
	u := p.user
	u.PasswordHash = hash
	if err := a.Store.UpdateUser(r.Context(), u); err != nil {
		a.fail(w, r, err)
		return
	}
	// Every other browser signed in as this user is signed out.
	if err := a.Store.DeleteOtherAuthSessions(r.Context(), u.ID, p.sessionID); err != nil {
		a.fail(w, r, err)
		return
	}
	noContent(w)
}

type authSessionView struct {
	ID         string `json:"id"`
	Browser    string `json:"browser"`
	OS         string `json:"os"`
	IP         string `json:"ip"`
	CreatedAt  int64  `json:"createdAt"`
	LastSeenAt int64  `json:"lastSeenAt"`
	Current    bool   `json:"current"`
}

func (a *API) listMySessions(w http.ResponseWriter, r *http.Request, p *principal) {
	list, err := a.Store.ListAuthSessions(r.Context(), p.user.ID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	out := make([]authSessionView, len(list))
	for i, s := range list {
		ua := useragent.Parse(s.UserAgent)
		out[i] = authSessionView{ID: s.ID, Browser: ua.Browser, OS: ua.OS, IP: s.IP, CreatedAt: s.CreatedAt,
			LastSeenAt: s.LastSeenAt, Current: s.ID == p.sessionID}
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) deleteMySession(w http.ResponseWriter, r *http.Request, p *principal) {
	if err := a.Store.DeleteAuthSession(r.Context(), p.user.ID, r.PathValue("id")); err != nil {
		a.fail(w, r, err)
		return
	}
	if r.PathValue("id") == p.sessionID {
		a.clearCookie(w)
	}
	noContent(w)
}

func (a *API) getPreferences(w http.ResponseWriter, r *http.Request, p *principal) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	prefs := p.user.Preferences
	if len(prefs) == 0 {
		prefs = []byte("{}")
	}
	w.Write(prefs)
}

func (a *API) putPreferences(w http.ResponseWriter, r *http.Request, p *principal) {
	var prefs map[string]json.RawMessage
	if err := decode(r, &prefs); err != nil || prefs == nil {
		a.fail(w, r, invalid("Preferences must be a JSON object", nil))
		return
	}
	u := p.user
	u.Preferences, _ = json.Marshal(prefs)
	if err := a.Store.UpdateUser(r.Context(), u); err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, prefs)
}
