package projects

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const maxDataAPIResponseBytes = 2 << 20

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type Project struct {
	ID        string          `json:"id"`
	Title     string          `json:"title"`
	Revision  int64           `json:"revision"`
	Document  json.RawMessage `json:"document"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
	OwnerID   string          `json:"-"`
}

type Page struct {
	Items      []Project `json:"items"`
	NextCursor string    `json:"nextCursor,omitempty"`
}

type Repository interface {
	Create(context.Context, string, string, string, json.RawMessage) (Project, error)
	List(context.Context, string, string, int, string) (Page, error)
	Get(context.Context, string, string, string) (Project, error)
	Update(context.Context, string, string, string, int64, string, json.RawMessage) (Project, error)
	Delete(context.Context, string, string, string) error
}

type RepositoryError struct {
	Code       string
	Constraint string
	Err        error
}

func (e *RepositoryError) Error() string { return "local Supabase Data API request failed" }
func (e *RepositoryError) Unwrap() error { return e.Err }

type DataAPI struct {
	baseURL string
	apiKey  string
	client  *http.Client
}

type dbProject struct {
	ID        string          `json:"id"`
	OwnerID   string          `json:"owner_id"`
	Title     string          `json:"title"`
	Revision  int64           `json:"revision"`
	Document  json.RawMessage `json:"document"`
	CreatedAt string          `json:"created_at"`
	UpdatedAt string          `json:"updated_at"`
}

func NewDataAPI(baseURL, apiKey string) (*DataAPI, error) {
	parsed, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || parsed == nil || parsed.Scheme != "http" || parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" || !isLoopback(parsed.Hostname()) {
		return nil, errors.New("Supabase Data API URL must be a loopback HTTP URL")
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("Supabase publishable key is required")
	}
	return &DataAPI{baseURL: strings.TrimRight(baseURL, "/"), apiKey: apiKey, client: &http.Client{Timeout: 8 * time.Second}}, nil
}

func (d *DataAPI) Create(ctx context.Context, token, owner, title string, document json.RawMessage) (Project, error) {
	payload, _ := json.Marshal(map[string]any{"title": title, "document": document})
	query := url.Values{"select": {"id,owner_id,title,revision,document,created_at,updated_at"}}
	body, err := d.request(ctx, http.MethodPost, "/rest/v1/projects?"+query.Encode(), token, payload, "return=representation")
	if err != nil {
		return Project{}, err
	}
	rows, err := decodeRows(body)
	if err != nil || len(rows) != 1 || rows[0].OwnerID != owner {
		return Project{}, errors.New("local Supabase Data API returned an invalid project response")
	}
	return publicProject(rows[0]), nil
}

func (d *DataAPI) List(ctx context.Context, token, owner string, limit int, cursor string) (Page, error) {
	query := url.Values{
		"select":   {"id,owner_id,title,revision,document,created_at,updated_at"},
		"owner_id": {"eq." + owner},
		"order":    {"updated_at.desc,id.desc"},
		"limit":    {strconv.Itoa(limit + 1)},
	}
	if cursor != "" {
		updatedAt, id, err := decodeCursor(cursor)
		if err != nil {
			return Page{}, err
		}
		query.Set("or", "(updated_at.lt."+updatedAt+",and(updated_at.eq."+updatedAt+",id.lt."+id+"))")
	}
	body, err := d.request(ctx, http.MethodGet, "/rest/v1/projects?"+query.Encode(), token, nil, "")
	if err != nil {
		return Page{}, err
	}
	rows, err := decodeRows(body)
	if err != nil {
		return Page{}, err
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	page := Page{Items: make([]Project, 0, len(rows))}
	for _, row := range rows {
		if row.OwnerID != owner {
			return Page{}, errors.New("local Supabase Data API returned an invalid owner")
		}
		page.Items = append(page.Items, publicProject(row))
	}
	if hasMore && len(rows) > 0 {
		last := rows[len(rows)-1]
		page.NextCursor = encodeCursor(last.UpdatedAt, last.ID)
	}
	return page, nil
}

func (d *DataAPI) Get(ctx context.Context, token, owner, id string) (Project, error) {
	query := url.Values{
		"select":   {"id,owner_id,title,revision,document,created_at,updated_at"},
		"owner_id": {"eq." + owner},
		"id":       {"eq." + id},
		"limit":    {"2"},
	}
	body, err := d.request(ctx, http.MethodGet, "/rest/v1/projects?"+query.Encode(), token, nil, "")
	if err != nil {
		return Project{}, err
	}
	rows, err := decodeRows(body)
	if err != nil {
		return Project{}, err
	}
	if len(rows) == 0 {
		return Project{}, ErrNotFound
	}
	if len(rows) != 1 || rows[0].OwnerID != owner {
		return Project{}, errors.New("local Supabase Data API returned an invalid project response")
	}
	return publicProject(rows[0]), nil
}

func (d *DataAPI) Update(ctx context.Context, token, owner, id string, revision int64, title string, document json.RawMessage) (Project, error) {
	payload, _ := json.Marshal(map[string]any{"p_id": id, "p_expected_revision": revision, "p_title": title, "p_document": document})
	body, err := d.request(ctx, http.MethodPost, "/rest/v1/rpc/update_project", token, payload, "")
	if err != nil {
		var repoErr *RepositoryError
		if errors.As(err, &repoErr) {
			switch repoErr.Code {
			case "40001":
				return Project{}, ErrConflict
			case "P0002":
				return Project{}, ErrNotFound
			}
		}
		return Project{}, err
	}
	rows, err := decodeRows(body)
	if err != nil || len(rows) != 1 || rows[0].OwnerID != owner {
		return Project{}, errors.New("local Supabase Data API returned an invalid project response")
	}
	return publicProject(rows[0]), nil
}

func (d *DataAPI) Delete(ctx context.Context, token, owner, id string) error {
	query := url.Values{
		"select":   {"id,owner_id"},
		"owner_id": {"eq." + owner},
		"id":       {"eq." + id},
		"limit":    {"2"},
	}
	body, err := d.request(ctx, http.MethodDelete, "/rest/v1/projects?"+query.Encode(), token, nil, "return=representation")
	if err != nil {
		return err
	}
	var rows []struct {
		ID      string `json:"id"`
		OwnerID string `json:"owner_id"`
	}
	if json.Unmarshal(body, &rows) != nil {
		return errors.New("local Supabase Data API returned an invalid delete response")
	}
	if len(rows) == 0 {
		return ErrNotFound
	}
	if len(rows) != 1 || rows[0].OwnerID != owner {
		return errors.New("local Supabase Data API returned an invalid delete response")
	}
	return nil
}

var (
	ErrNotFound = errors.New("project not found")
	ErrConflict = errors.New("project revision conflict")
	ErrLimit    = errors.New("project limit reached")
	ErrTooLarge = errors.New("project document exceeds size limit")
	ErrInvalid  = errors.New("project document was rejected")
)

func (d *DataAPI) request(ctx context.Context, method, path, token string, payload []byte, prefer string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, method, d.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return nil, errors.New("could not create local Supabase request")
	}
	request.Header.Set("apikey", d.apiKey)
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept-Profile", "public")
	request.Header.Set("Content-Profile", "public")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if prefer != "" {
		request.Header.Set("Prefer", prefer)
	}
	response, err := d.client.Do(request)
	if err != nil {
		return nil, errors.New("local Supabase Data API unavailable")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxDataAPIResponseBytes+1))
	if err != nil || len(body) > maxDataAPIResponseBytes {
		return nil, errors.New("local Supabase Data API response invalid")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var errorEnvelope struct {
			Code       string `json:"code"`
			Constraint string `json:"constraint"`
		}
		_ = json.Unmarshal(body, &errorEnvelope)
		return nil, &RepositoryError{Code: errorEnvelope.Code, Constraint: errorEnvelope.Constraint, Err: fmt.Errorf("HTTP %d", response.StatusCode)}
	}
	return body, nil
}

func decodeRows(body []byte) ([]dbProject, error) {
	var rows []dbProject
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, errors.New("local Supabase Data API returned invalid JSON")
	}
	return rows, nil
}

func publicProject(row dbProject) Project {
	return Project{ID: row.ID, Title: row.Title, Revision: row.Revision, Document: row.Document, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, OwnerID: row.OwnerID}
}

func encodeCursor(updatedAt, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(updatedAt + "\n" + id))
}

func decodeCursor(value string) (string, string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return "", "", errors.New("invalid cursor")
	}
	parts := strings.Split(string(raw), "\n")
	if len(parts) != 2 {
		return "", "", errors.New("invalid cursor")
	}
	if _, err := time.Parse(time.RFC3339Nano, parts[0]); err != nil || !validUUID(parts[1]) {
		return "", "", errors.New("invalid cursor")
	}
	return parts[0], parts[1], nil
}

func validUUID(value string) bool { return uuidPattern.MatchString(value) }

func isLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
