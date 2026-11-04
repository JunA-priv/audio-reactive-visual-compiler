package audiojobs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// TaskTransport sends only a job identity; PostgreSQL remains authoritative.
type TaskTransport interface {
	Enqueue(context.Context, DispatchItem) (string, error)
}
type AccessTokenSource interface {
	Token(context.Context) (string, error)
}
type CloudTasksREST struct {
	Project, Location, Queue, WorkerURL, Audience, InvokerServiceAccount, Endpoint string
	Client                                                                         *http.Client
	Tokens                                                                         AccessTokenSource
}

func (c *CloudTasksREST) Enqueue(ctx context.Context, item DispatchItem) (string, error) {
	if c == nil || c.Project == "" || c.Location == "" || c.Queue == "" || c.WorkerURL == "" || c.InvokerServiceAccount == "" || item.JobID == "" || item.Generation < 1 || c.Tokens == nil {
		return "", errors.New("cloud tasks configuration incomplete")
	}
	token, err := c.Tokens.Token(ctx)
	if err != nil || token == "" {
		return "", errors.New("cloud tasks token unavailable")
	}
	queue := fmt.Sprintf("projects/%s/locations/%s/queues/%s", url.PathEscape(c.Project), url.PathEscape(c.Location), url.PathEscape(c.Queue))
	name := fmt.Sprintf("%s/tasks/arvc-%s-g%d", queue, strings.ReplaceAll(item.JobID, "-", ""), item.Generation)
	body := struct {
		Task struct {
			Name        string `json:"name"`
			HttpRequest struct {
				Url     string            `json:"url"`
				Method  string            `json:"httpMethod"`
				Headers map[string]string `json:"headers"`
				Body    []byte            `json:"body"`
				OIDC    struct {
					Email    string `json:"serviceAccountEmail"`
					Audience string `json:"audience"`
				} `json:"oidcToken"`
			} `json:"httpRequest"`
			DispatchDeadline string `json:"dispatchDeadline"`
		} `json:"task"`
	}{}
	body.Task.Name = name
	body.Task.DispatchDeadline = "720s"
	body.Task.HttpRequest.Url = c.WorkerURL
	body.Task.HttpRequest.Method = "POST"
	body.Task.HttpRequest.Headers = map[string]string{"Content-Type": "application/json"}
	body.Task.HttpRequest.Body, _ = json.Marshal(item)
	body.Task.HttpRequest.OIDC.Email = c.InvokerServiceAccount
	body.Task.HttpRequest.OIDC.Audience = c.Audience
	if body.Task.HttpRequest.OIDC.Audience == "" {
		body.Task.HttpRequest.OIDC.Audience = c.WorkerURL
	}
	endpoint := c.Endpoint
	if endpoint == "" {
		endpoint = "https://cloudtasks.googleapis.com"
	}
	if !strings.HasPrefix(endpoint, "https://") && !strings.HasPrefix(endpoint, "http://127.0.0.1:") && !strings.HasPrefix(endpoint, "http://localhost:") {
		return "", errors.New("cloud tasks endpoint invalid")
	}
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(endpoint, "/")+"/v2/"+queue+"/tasks", bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", errors.New("cloud tasks request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusConflict {
		return name, nil
	} // deterministic task name: ambiguous prior create is safe
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("cloud tasks request returned status %d", resp.StatusCode)
	}
	return name, nil
}

// OutboxDispatcher is safe to call from submit, task completion, and a periodic repair trigger.
type OutboxDispatcher struct {
	Store     DispatchStore
	Transport TaskTransport
}

func (d *OutboxDispatcher) Dispatch(ctx context.Context) error {
	if d == nil || d.Store == nil || d.Transport == nil {
		return errors.New("dispatcher unavailable")
	}
	items, err := d.Store.ClaimDispatch(ctx, 2)
	if err != nil {
		return err
	}
	var first error
	for _, item := range items {
		name, sendErr := d.Transport.Enqueue(ctx, item)
		if sendErr != nil {
			_ = d.Store.MarkDispatchFailed(ctx, item, "dispatch_failed")
			if first == nil {
				first = sendErr
			}
			continue
		}
		if err := d.Store.MarkDispatchSent(ctx, item, name); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// MetadataTokenSource uses the Cloud Run service identity without embedding credentials.
type MetadataTokenSource struct{ Client *http.Client }

func (m MetadataTokenSource) Token(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Metadata-Flavor", "Google")
	client := m.Client
	if client == nil {
		client = &http.Client{Timeout: 3 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", errors.New("metadata token unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", errors.New("metadata token unavailable")
	}
	var v struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 8192)).Decode(&v); err != nil || v.AccessToken == "" {
		return "", errors.New("metadata token unavailable")
	}
	return v.AccessToken, nil
}
