package audiojobs

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type fixedToken string

func (f fixedToken) Token(context.Context) (string, error) { return string(f), nil }

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestCloudTasksEnqueueMinimalPayloadAndDuplicate(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusConflict} {
		client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer secret" {
				t.Errorf("request auth/method mismatch")
			}
			b, _ := io.ReadAll(r.Body)
			var envelope struct {
				Task struct {
					HTTPRequest struct {
						Body string `json:"body"`
					} `json:"httpRequest"`
				} `json:"task"`
			}
			if err := json.Unmarshal(b, &envelope); err != nil {
				t.Error(err)
			}
			payload, _ := base64.StdEncoding.DecodeString(envelope.Task.HTTPRequest.Body)
			body := string(payload)
			if !strings.Contains(body, `"jobId":"12345678-1234-1234-1234-123456789abc"`) || !strings.Contains(body, `"generation":2`) || strings.Contains(body, "audio_wav") {
				t.Errorf("unexpected task payload: %s", body)
			}
			return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(`{}`)), Header: make(http.Header)}, nil
		})}
		c := &CloudTasksREST{Project: "p", Location: "l", Queue: "q", WorkerURL: "https://worker.example/task", InvokerServiceAccount: "task@example.iam.gserviceaccount.com", Tokens: fixedToken("secret"), Client: client, Endpoint: "http://localhost:8080"}
		if _, err := c.Enqueue(context.Background(), DispatchItem{JobID: "12345678-1234-1234-1234-123456789abc", Generation: 2}); err != nil {
			t.Fatalf("enqueue status %d: %v", status, err)
		}
	}
}
func TestCloudTasksRejectsServerFailure(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 503, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
	})}
	c := &CloudTasksREST{Project: "p", Location: "l", Queue: "q", WorkerURL: "https://worker.example", InvokerServiceAccount: "task@example", Tokens: fixedToken("x"), Client: client, Endpoint: "http://localhost:8080"}
	if _, err := c.Enqueue(context.Background(), DispatchItem{JobID: "12345678-1234-1234-1234-123456789abc", Generation: 1}); err == nil {
		t.Fatal("expected failure")
	}
}

type fakeDispatchStore struct {
	items        []DispatchItem
	sent, failed int
	failure      string
}

func (s *fakeDispatchStore) ClaimDispatch(context.Context, int) ([]DispatchItem, error) {
	return s.items, nil
}
func (s *fakeDispatchStore) MarkDispatchSent(context.Context, DispatchItem, string) error {
	s.sent++
	return nil
}
func (s *fakeDispatchStore) MarkDispatchFailed(_ context.Context, _ DispatchItem, code string) error {
	s.failed++
	s.failure = code
	return nil
}
func (*fakeDispatchStore) ClaimTask(context.Context, DispatchItem) (string, Job, error) {
	return "", Job{}, nil
}
func (*fakeDispatchStore) MarkDispatchDone(context.Context, DispatchItem) error { return nil }

type fakeTaskTransport struct {
	err  error
	sent int
}

func (t *fakeTaskTransport) Enqueue(context.Context, DispatchItem) (string, error) {
	t.sent++
	return "task-name", t.err
}
func TestOutboxDispatchPersistsSuccessAndFailure(t *testing.T) {
	item := DispatchItem{JobID: "job", Generation: 1}
	store := &fakeDispatchStore{items: []DispatchItem{item}}
	transport := &fakeTaskTransport{}
	if err := (&OutboxDispatcher{Store: store, Transport: transport}).Dispatch(context.Background()); err != nil || store.sent != 1 || store.failed != 0 {
		t.Fatalf("success: err=%v sent=%d failed=%d", err, store.sent, store.failed)
	}
	store = &fakeDispatchStore{items: []DispatchItem{item}}
	transport = &fakeTaskTransport{err: errors.New("temporary")}
	if err := (&OutboxDispatcher{Store: store, Transport: transport}).Dispatch(context.Background()); err == nil || store.failed != 1 || store.failure != "dispatch_failed" {
		t.Fatalf("failure not persisted: err=%v failed=%d code=%s", err, store.failed, store.failure)
	}
}
