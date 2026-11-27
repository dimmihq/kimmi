package api

import (
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/dimmihq/kimmi/internal/auth"
	"github.com/dimmihq/kimmi/internal/store"
)

const invitationTTL = 7 * 24 * time.Hour

func (a *API) listMembers(w http.ResponseWriter, r *http.Request, p *principal) {
	users, err := a.Store.ListUsers(r.Context(), p.user.OrgID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if users == nil {
		users = []store.User{}
	}
	writeJSON(w, http.StatusOK, users)
}

// member loads a user of the caller's org and checks the caller may manage
// them: only owners manage owners.
func (a *API) member(r *http.Request, p *principal) (store.User, error) {
	u, err := a.Store.GetUser(r.Context(), r.PathValue("id"))
	if err != nil {
		return u, err
	}
	if u.OrgID != p.user.OrgID {
		return u, errNotFound
	}
	if u.Role == store.RoleOwner && p.user.Role != store.RoleOwner {
		return u, forbidden("Only an owner can change another owner")
	}
	return u, nil
}

// keepAnOwner refuses a change that would leave the org without an owner.
func (a *API) keepAnOwner(r *http.Request, u store.User) error {
	if u.Role != store.RoleOwner {
		return nil
	}
	n, err := a.Store.CountOwners(r.Context(), u.OrgID)
	if err != nil {
		return err
	}
	if n <= 1 {
		return &apiError{status: http.StatusConflict, code: "last_owner", msg: "A workspace needs at least one owner"}
	}
	return nil
}

func (a *API) updateMember(w http.ResponseWriter, r *http.Request, p *principal) {
	var in struct{ Role string }
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	if !auth.ValidRole(in.Role) {
		a.fail(w, r, invalid("Unknown role", map[string]string{"role": "Must be owner, admin, member or viewer"}))
		return
	}
	if in.Role == store.RoleOwner && p.user.Role != store.RoleOwner {
		a.fail(w, r, forbidden("Only an owner can make someone an owner"))
		return
	}
	u, err := a.member(r, p)
	if err == nil && in.Role != store.RoleOwner {
		err = a.keepAnOwner(r, u)
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	u.Role = in.Role
	if err := a.Store.UpdateUser(r.Context(), u); err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (a *API) deleteMember(w http.ResponseWriter, r *http.Request, p *principal) {
	u, err := a.member(r, p)
	if err == nil {
		err = a.keepAnOwner(r, u)
	}
	if err == nil {
		err = a.Store.DeleteUser(r.Context(), u.OrgID, u.ID)
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	noContent(w)
}

type invitationView struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	Role      string `json:"role"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
	Link      string `json:"link"`
}

func (a *API) invitationToken(id string) string { return a.Signer.Derive("invite:" + id) }

func (a *API) invitationView(i store.Invitation) invitationView {
	return invitationView{ID: i.ID, Email: i.Email, Role: i.Role, CreatedAt: i.CreatedAt, ExpiresAt: i.ExpiresAt,
		Link: a.Config.PublicURL + "/invite/" + a.invitationToken(i.ID)}
}

func (a *API) listInvitations(w http.ResponseWriter, r *http.Request, p *principal) {
	list, err := a.Store.ListPendingInvitations(r.Context(), p.user.OrgID, time.Now().UnixMilli())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	out := make([]invitationView, len(list))
	for i, inv := range list {
		out[i] = a.invitationView(inv)
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) createInvitation(w http.ResponseWriter, r *http.Request, p *principal) {
	var in struct{ Email, Role string }
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	fields := map[string]string{}
	if addr, err := mail.ParseAddress(in.Email); err != nil || addr.Address != in.Email {
		fields["email"] = "Not a valid email address"
	}
	if !auth.ValidRole(in.Role) {
		fields["role"] = "Must be owner, admin, member or viewer"
	}
	if len(fields) > 0 {
		a.fail(w, r, invalid("Check the highlighted fields", fields))
		return
	}
	if in.Role == store.RoleOwner && p.user.Role != store.RoleOwner {
		a.fail(w, r, forbidden("Only an owner can invite an owner"))
		return
	}
	if _, err := a.Store.GetUserByEmail(r.Context(), in.Email); err == nil {
		a.fail(w, r, &apiError{status: http.StatusConflict, code: "conflict", msg: "Someone with this email already has an account",
			fields: map[string]string{"email": "Already has an account"}})
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		a.fail(w, r, err)
		return
	}
	now := time.Now()
	inv := store.Invitation{ID: store.NewID(), OrgID: p.user.OrgID, Email: in.Email, Role: in.Role,
		InvitedBy: p.user.ID, CreatedAt: now.UnixMilli(), ExpiresAt: now.Add(invitationTTL).UnixMilli()}
	inv.TokenHash = auth.HashToken(a.invitationToken(inv.ID))
	if err := a.Store.CreateInvitation(r.Context(), inv); err != nil {
		a.fail(w, r, err)
		return
	}
	view := a.invitationView(inv)
	writeJSON(w, http.StatusCreated, map[string]any{"invitation": view, "link": view.Link})
}

func (a *API) deleteInvitation(w http.ResponseWriter, r *http.Request, p *principal) {
	if err := a.Store.DeleteInvitation(r.Context(), p.user.OrgID, r.PathValue("id")); err != nil {
		a.fail(w, r, err)
		return
	}
	noContent(w)
}

// pendingInvitation finds an unused, unexpired invitation by its link token.
func (a *API) pendingInvitation(r *http.Request, token string) (store.Invitation, error) {
	inv, err := a.Store.GetInvitationByHash(r.Context(), auth.HashToken(token))
	if err != nil {
		return inv, err
	}
	if inv.AcceptedAt != nil || inv.ExpiresAt <= time.Now().UnixMilli() {
		return inv, errNotFound
	}
	return inv, nil
}

func (a *API) lookupInvitation(w http.ResponseWriter, r *http.Request) {
	inv, err := a.pendingInvitation(r, r.PathValue("token"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	org, err := a.Store.GetOrg(r.Context(), inv.OrgID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"email": inv.Email, "orgName": org.Name, "role": inv.Role})
}

func (a *API) acceptInvitation(w http.ResponseWriter, r *http.Request) {
	var in struct{ Token, Name, Password string }
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	inv, err := a.pendingInvitation(r, in.Token)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	fields := map[string]string{}
	checkAccount(in.Name, "", in.Password, fields)
	if len(fields) > 0 {
		a.fail(w, r, invalid("Check the highlighted fields", fields))
		return
	}
	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	now := time.Now().UnixMilli()
	u := store.User{ID: store.NewID(), OrgID: inv.OrgID, Name: strings.TrimSpace(in.Name), Email: inv.Email,
		PasswordHash: hash, Role: inv.Role, CreatedAt: now}
	if err := a.Store.AcceptInvitation(r.Context(), inv.ID, u, now); err != nil {
		if errors.Is(err, store.ErrConflict) {
			err = &apiError{status: http.StatusConflict, code: "conflict", msg: "Email is already in use"}
		}
		a.fail(w, r, err)
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
	writeJSON(w, http.StatusCreated, body)
}

type tokenView struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Prefix     string `json:"prefix"`
	Access     string `json:"access"`
	CreatedAt  int64  `json:"createdAt"`
	LastUsedAt *int64 `json:"lastUsedAt"`
	ExpiresAt  *int64 `json:"expiresAt"`
}

func newTokenView(t store.APIToken) tokenView {
	return tokenView{ID: t.ID, Name: t.Name, Prefix: t.Prefix, Access: t.Access, CreatedAt: t.CreatedAt,
		LastUsedAt: t.LastUsedAt, ExpiresAt: t.ExpiresAt}
}

func (a *API) listTokens(w http.ResponseWriter, r *http.Request, p *principal) {
	list, err := a.Store.ListAPITokens(r.Context(), p.user.OrgID, p.user.ID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	out := make([]tokenView, len(list))
	for i, t := range list {
		out[i] = newTokenView(t)
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) createToken(w http.ResponseWriter, r *http.Request, p *principal) {
	var in struct {
		Name          string
		Access        string
		ExpiresInDays *int
	}
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	fields := map[string]string{}
	if in.Name = strings.TrimSpace(in.Name); in.Name == "" {
		fields["name"] = "Required"
	}
	if in.Access != "read" && in.Access != "write" {
		fields["access"] = "Must be read or write"
	}
	if in.ExpiresInDays != nil && (*in.ExpiresInDays < 1 || *in.ExpiresInDays > 3650) {
		fields["expiresInDays"] = "Between 1 and 3650 days, or null for never"
	}
	if len(fields) > 0 {
		a.fail(w, r, invalid("Check the highlighted fields", fields))
		return
	}
	now := time.Now()
	secret := auth.NewToken()
	t := store.APIToken{ID: store.NewID(), OrgID: p.user.OrgID, UserID: p.user.ID, Name: in.Name,
		Prefix: auth.TokenDisplayPrefix(secret), TokenHash: auth.HashToken(secret), Access: in.Access, CreatedAt: now.UnixMilli()}
	if in.ExpiresInDays != nil {
		exp := now.AddDate(0, 0, *in.ExpiresInDays).UnixMilli()
		t.ExpiresAt = &exp
	}
	if err := a.Store.CreateAPIToken(r.Context(), t); err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"token": newTokenView(t), "secret": secret})
}

func (a *API) deleteToken(w http.ResponseWriter, r *http.Request, p *principal) {
	if err := a.Store.DeleteAPIToken(r.Context(), p.user.OrgID, p.user.ID, r.PathValue("id")); err != nil {
		a.fail(w, r, err)
		return
	}
	noContent(w)
}
