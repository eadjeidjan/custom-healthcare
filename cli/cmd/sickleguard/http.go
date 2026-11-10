package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

var httpc = &http.Client{Timeout: 15 * time.Second}

// Health is GET /api/v1/health.
type Health struct {
	OK      bool   `json:"ok"`
	Version string `json:"version"`
	OpenAI  bool   `json:"openai"`
	Qdrant  bool   `json:"qdrant"`
	MCP     bool   `json:"mcp"`
	Model   struct {
		Version string  `json:"version"`
		AUC     float64 `json:"auc"`
	} `json:"model"`
}

func getJSON(url, token string, out any) (int, error) {
	req, _ := http.NewRequest("GET", url, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := httpc.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode/100 != 2 {
		return resp.StatusCode, fmt.Errorf("GET %s: HTTP %d", url, resp.StatusCode)
	}
	if out != nil {
		if err := json.Unmarshal(body, out); err != nil {
			return resp.StatusCode, fmt.Errorf("GET %s: %w", url, err)
		}
	}
	return resp.StatusCode, nil
}

// health asks the API (through the web container's nginx) once.
func health(base string) (*Health, error) {
	var h Health
	if _, err := getJSON(base+"/api/v1/health", "", &h); err != nil {
		return nil, err
	}
	if !h.OK {
		return &h, errors.New("health says not ok")
	}
	return &h, nil
}

// waitHealth polls /api/v1/health until it answers ok or timeout passes.
func waitHealth(base string, timeout time.Duration) (*Health, error) {
	deadline := time.Now().Add(timeout)
	var last error
	for {
		h, err := health(base)
		if err == nil {
			return h, nil
		}
		last = err
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("no healthy answer from %s/api/v1/health within %s: %v", base, timeout, last)
		}
		time.Sleep(3 * time.Second)
	}
}

// errBadLogin means the admin password in the settings no longer signs in (changed through the app or `users`).
var errBadLogin = errors.New("ADMIN_EMAIL / ADMIN_PASSWORD from the settings do not sign in")

// login returns a token for email/password.
func login(base, email, password string) (string, error) {
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})
	resp, err := httpc.Post(base+"/api/v1/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 {
		return "", errBadLogin
	}
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("sign-in: HTTP %d", resp.StatusCode)
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.Token == "" {
		return "", errors.New("sign-in: no token in the answer")
	}
	return out.Token, nil
}

// smoke signs in as the administrator and loads the dashboard. A changed admin password is a warning (the app
// works, the check cannot sign in); any other failure is an error.
func (a *App) smoke(base string) (warning string, err error) {
	email, pw := a.Env.Value("ADMIN_EMAIL"), a.Env.Value("ADMIN_PASSWORD")
	if email == "" {
		email = "admin@sickleguard.local"
	}
	if pw == "" {
		return "ADMIN_PASSWORD is empty: signed-in smoke test skipped", nil
	}
	tok, err := login(base, email, pw)
	if errors.Is(err, errBadLogin) {
		return errBadLogin.Error() + " (password changed since?): signed-in smoke test skipped", nil
	}
	if err != nil {
		return "", err
	}
	var dash struct {
		Patients *int `json:"patients"`
	}
	if _, err := getJSON(base+"/api/v1/dashboard", tok, &dash); err != nil {
		return "", err
	}
	if dash.Patients == nil {
		return "", errors.New("dashboard answer has no patient count")
	}
	return "", nil
}
