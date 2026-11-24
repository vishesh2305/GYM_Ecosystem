-- Identity tables are used only by the auth module (owner role), never inside a tenant scope.
REVOKE ALL ON users, sessions, refresh_tokens FROM app_user;
