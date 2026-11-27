package sqlstore

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/dimmihq/kimmi/internal/store"
)

func (d *DB) HasUsers(ctx context.Context) (bool, error) {
	var n int
	if err := d.r.row(ctx, "SELECT COUNT(*) FROM (SELECT 1 FROM users LIMIT 1) t").Scan(&n); err != nil {
		return false, fmt.Errorf("count users: %w", err)
	}
	return n > 0, nil
}

func (d *DB) CreateOrgWithOwner(ctx context.Context, org store.Org, owner store.User) error {
	err := d.tx(ctx, func(c conn) error {
		if _, err := c.exec(ctx, "INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)", org.ID, org.Name, org.CreatedAt); err != nil {
			return err
		}
		return insertUser(ctx, c, owner)
	})
	if isUnique(err) {
		return store.ErrConflict
	}
	if err != nil {
		return fmt.Errorf("create org: %w", err)
	}
	return nil
}

func (d *DB) CreateOrg(ctx context.Context, org store.Org) error {
	if _, err := d.w.exec(ctx, "INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)", org.ID, org.Name, org.CreatedAt); err != nil {
		return fmt.Errorf("create org: %w", err)
	}
	return nil
}

func (d *DB) FirstOrg(ctx context.Context) (store.Org, error) {
	var o store.Org
	err := d.r.row(ctx, "SELECT id, name, created_at FROM orgs ORDER BY created_at, id LIMIT 1").Scan(&o.ID, &o.Name, &o.CreatedAt)
	if err != nil {
		return o, fmt.Errorf("first org: %w", notFound(err))
	}
	return o, nil
}

func (d *DB) GetOrg(ctx context.Context, id string) (store.Org, error) {
	var o store.Org
	err := d.r.row(ctx, "SELECT id, name, created_at FROM orgs WHERE id = ?", id).Scan(&o.ID, &o.Name, &o.CreatedAt)
	if err != nil {
		return o, fmt.Errorf("get org: %w", notFound(err))
	}
	return o, nil
}

func insertUser(ctx context.Context, c conn, u store.User) error {
	prefs := u.Preferences
	if len(prefs) == 0 {
		prefs = []byte("{}")
	}
	_, err := c.exec(ctx, `INSERT INTO users (id, org_id, name, email, password_hash, role, preferences, created_at, last_login_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, u.OrgID, u.Name, strings.ToLower(u.Email), u.PasswordHash, u.Role, string(prefs), u.CreatedAt, u.LastLoginAt)
	return err
}

func (d *DB) CreateUser(ctx context.Context, u store.User) error {
	err := insertUser(ctx, d.w, u)
	if isUnique(err) {
		return store.ErrConflict
	}
	if err != nil {
		return fmt.Errorf("create user: %w", err)
	}
	return nil
}

const userCols = "id, org_id, name, email, password_hash, role, preferences, created_at, last_login_at"

func scanUser(s interface{ Scan(...any) error }) (store.User, error) {
	var u store.User
	var prefs string
	err := s.Scan(&u.ID, &u.OrgID, &u.Name, &u.Email, &u.PasswordHash, &u.Role, &prefs, &u.CreatedAt, &u.LastLoginAt)
	u.Preferences = []byte(prefs)
	return u, err
}

func (d *DB) GetUser(ctx context.Context, id string) (store.User, error) {
	u, err := scanUser(d.r.row(ctx, "SELECT "+userCols+" FROM users WHERE id = ?", id))
	if err != nil {
		return u, fmt.Errorf("get user: %w", notFound(err))
	}
	return u, nil
}

func (d *DB) GetUserByEmail(ctx context.Context, email string) (store.User, error) {
	u, err := scanUser(d.r.row(ctx, "SELECT "+userCols+" FROM users WHERE email = ?", strings.ToLower(email)))
	if err != nil {
		return u, fmt.Errorf("get user by email: %w", notFound(err))
	}
	return u, nil
}

func (d *DB) ListUsers(ctx context.Context, orgID string) ([]store.User, error) {
	rows, err := d.r.query(ctx, "SELECT "+userCols+" FROM users WHERE org_id = ? ORDER BY created_at", orgID)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()
	var out []store.User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, fmt.Errorf("list users: %w", err)
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (d *DB) UpdateUser(ctx context.Context, u store.User) error {
	err := mustAffect(d.w.exec(ctx, `UPDATE users SET name = ?, email = ?, password_hash = ?, role = ?, preferences = ?, last_login_at = ?
		WHERE id = ? AND org_id = ?`,
		u.Name, strings.ToLower(u.Email), u.PasswordHash, u.Role, string(u.Preferences), u.LastLoginAt, u.ID, u.OrgID))
	if isUnique(err) {
		return store.ErrConflict
	}
	if err != nil {
		return fmt.Errorf("update user: %w", err)
	}
	return nil
}

func (d *DB) DeleteUser(ctx context.Context, orgID, id string) error {
	if err := mustAffect(d.w.exec(ctx, "DELETE FROM users WHERE id = ? AND org_id = ?", id, orgID)); err != nil {
		return fmt.Errorf("delete user: %w", err)
	}
	return nil
}

func (d *DB) CountOwners(ctx context.Context, orgID string) (int, error) {
	var n int
	err := d.r.row(ctx, "SELECT COUNT(*) FROM users WHERE org_id = ? AND role = ?", orgID, store.RoleOwner).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count owners: %w", err)
	}
	return n, nil
}

func (d *DB) CreateAuthSession(ctx context.Context, s store.AuthSession) error {
	_, err := d.w.exec(ctx, `INSERT INTO auth_sessions (id, user_id, token_hash, user_agent, ip, created_at, last_seen_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, s.ID, s.UserID, s.TokenHash, s.UserAgent, s.IP, s.CreatedAt, s.LastSeenAt)
	if err != nil {
		return fmt.Errorf("create auth session: %w", err)
	}
	return nil
}

const authSessionCols = "id, user_id, token_hash, user_agent, ip, created_at, last_seen_at"

func scanAuthSession(s interface{ Scan(...any) error }) (store.AuthSession, error) {
	var a store.AuthSession
	err := s.Scan(&a.ID, &a.UserID, &a.TokenHash, &a.UserAgent, &a.IP, &a.CreatedAt, &a.LastSeenAt)
	return a, err
}

func (d *DB) GetAuthSessionByHash(ctx context.Context, tokenHash string) (store.AuthSession, error) {
	a, err := scanAuthSession(d.r.row(ctx, "SELECT "+authSessionCols+" FROM auth_sessions WHERE token_hash = ?", tokenHash))
	if err != nil {
		return a, fmt.Errorf("get auth session: %w", notFound(err))
	}
	return a, nil
}

func (d *DB) TouchAuthSession(ctx context.Context, id string, at int64) error {
	if _, err := d.w.exec(ctx, "UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?", at, id); err != nil {
		return fmt.Errorf("touch auth session: %w", err)
	}
	return nil
}

func (d *DB) ListAuthSessions(ctx context.Context, userID string) ([]store.AuthSession, error) {
	rows, err := d.r.query(ctx, "SELECT "+authSessionCols+" FROM auth_sessions WHERE user_id = ? ORDER BY last_seen_at DESC", userID)
	if err != nil {
		return nil, fmt.Errorf("list auth sessions: %w", err)
	}
	defer rows.Close()
	var out []store.AuthSession
	for rows.Next() {
		a, err := scanAuthSession(rows)
		if err != nil {
			return nil, fmt.Errorf("list auth sessions: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (d *DB) DeleteAuthSession(ctx context.Context, userID, id string) error {
	if err := mustAffect(d.w.exec(ctx, "DELETE FROM auth_sessions WHERE id = ? AND user_id = ?", id, userID)); err != nil {
		return fmt.Errorf("delete auth session: %w", err)
	}
	return nil
}

func (d *DB) DeleteOtherAuthSessions(ctx context.Context, userID, keepID string) error {
	if _, err := d.w.exec(ctx, "DELETE FROM auth_sessions WHERE user_id = ? AND id <> ?", userID, keepID); err != nil {
		return fmt.Errorf("delete auth sessions: %w", err)
	}
	return nil
}

func (d *DB) CreateInvitation(ctx context.Context, inv store.Invitation) error {
	_, err := d.w.exec(ctx, `INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		inv.ID, inv.OrgID, strings.ToLower(inv.Email), inv.Role, inv.TokenHash, inv.InvitedBy, inv.CreatedAt, inv.ExpiresAt)
	if err != nil {
		return fmt.Errorf("create invitation: %w", err)
	}
	return nil
}

const invitationCols = "id, org_id, email, role, token_hash, invited_by, created_at, expires_at, accepted_at"

func scanInvitation(s interface{ Scan(...any) error }) (store.Invitation, error) {
	var i store.Invitation
	err := s.Scan(&i.ID, &i.OrgID, &i.Email, &i.Role, &i.TokenHash, &i.InvitedBy, &i.CreatedAt, &i.ExpiresAt, &i.AcceptedAt)
	return i, err
}

func (d *DB) ListPendingInvitations(ctx context.Context, orgID string, now int64) ([]store.Invitation, error) {
	rows, err := d.r.query(ctx, "SELECT "+invitationCols+` FROM invitations
		WHERE org_id = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC`, orgID, now)
	if err != nil {
		return nil, fmt.Errorf("list invitations: %w", err)
	}
	defer rows.Close()
	var out []store.Invitation
	for rows.Next() {
		i, err := scanInvitation(rows)
		if err != nil {
			return nil, fmt.Errorf("list invitations: %w", err)
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

func (d *DB) GetInvitationByHash(ctx context.Context, tokenHash string) (store.Invitation, error) {
	i, err := scanInvitation(d.r.row(ctx, "SELECT "+invitationCols+" FROM invitations WHERE token_hash = ?", tokenHash))
	if err != nil {
		return i, fmt.Errorf("get invitation: %w", notFound(err))
	}
	return i, nil
}

func (d *DB) DeleteInvitation(ctx context.Context, orgID, id string) error {
	if err := mustAffect(d.w.exec(ctx, "DELETE FROM invitations WHERE id = ? AND org_id = ?", id, orgID)); err != nil {
		return fmt.Errorf("delete invitation: %w", err)
	}
	return nil
}

func (d *DB) AcceptInvitation(ctx context.Context, invitationID string, u store.User, at int64) error {
	err := d.tx(ctx, func(c conn) error {
		if err := mustAffect(c.exec(ctx, "UPDATE invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL", at, invitationID)); err != nil {
			return err
		}
		return insertUser(ctx, c, u)
	})
	if isUnique(err) {
		return store.ErrConflict
	}
	if err != nil {
		return fmt.Errorf("accept invitation: %w", err)
	}
	return nil
}

func (d *DB) CreateAPIToken(ctx context.Context, t store.APIToken) error {
	_, err := d.w.exec(ctx, `INSERT INTO api_tokens (id, org_id, user_id, name, prefix, token_hash, access, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ID, t.OrgID, t.UserID, t.Name, t.Prefix, t.TokenHash, t.Access, t.CreatedAt, t.ExpiresAt)
	if err != nil {
		return fmt.Errorf("create api token: %w", err)
	}
	return nil
}

const tokenCols = "id, org_id, user_id, name, prefix, token_hash, access, created_at, last_used_at, expires_at"

func scanToken(s interface{ Scan(...any) error }) (store.APIToken, error) {
	var t store.APIToken
	err := s.Scan(&t.ID, &t.OrgID, &t.UserID, &t.Name, &t.Prefix, &t.TokenHash, &t.Access, &t.CreatedAt, &t.LastUsedAt, &t.ExpiresAt)
	return t, err
}

func (d *DB) ListAPITokens(ctx context.Context, orgID, userID string) ([]store.APIToken, error) {
	rows, err := d.r.query(ctx, "SELECT "+tokenCols+" FROM api_tokens WHERE org_id = ? AND user_id = ? ORDER BY created_at DESC", orgID, userID)
	if err != nil {
		return nil, fmt.Errorf("list api tokens: %w", err)
	}
	defer rows.Close()
	var out []store.APIToken
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, fmt.Errorf("list api tokens: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (d *DB) GetAPITokenByHash(ctx context.Context, tokenHash string) (store.APIToken, error) {
	t, err := scanToken(d.r.row(ctx, "SELECT "+tokenCols+" FROM api_tokens WHERE token_hash = ?", tokenHash))
	if err != nil {
		return t, fmt.Errorf("get api token: %w", notFound(err))
	}
	return t, nil
}

func (d *DB) TouchAPIToken(ctx context.Context, id string, at int64) error {
	if _, err := d.w.exec(ctx, "UPDATE api_tokens SET last_used_at = ? WHERE id = ?", at, id); err != nil {
		return fmt.Errorf("touch api token: %w", err)
	}
	return nil
}

func (d *DB) DeleteAPIToken(ctx context.Context, orgID, userID, id string) error {
	if err := mustAffect(d.w.exec(ctx, "DELETE FROM api_tokens WHERE id = ? AND org_id = ? AND user_id = ?", id, orgID, userID)); err != nil {
		return fmt.Errorf("delete api token: %w", err)
	}
	return nil
}

// nullString stores "" as NULL.
func nullString(s string) sql.NullString { return sql.NullString{String: s, Valid: s != ""} }
