package aibudget

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLocalBudgetRoleCanOnlyReachReservationRPC(t *testing.T) {
	if os.Getenv("ARVC_STEP7G_LOCAL_INTEGRATION") != "1" {
		t.Skip("set ARVC_STEP7G_LOCAL_INTEGRATION=1 for the isolated local Supabase check")
	}
	dsn := os.Getenv("SUPABASE_AI_BUDGET_DSN")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	store, err := NewPostgres(ctx, dsn)
	if err != nil {
		cfg, parseErr := pgxpool.ParseConfig(dsn)
		if parseErr != nil {
			t.Fatal("dedicated local AI budget DSN parse failed")
		}
		if cfg.ConnConfig.User != "arvc_ai_budget" || (cfg.ConnConfig.Host != "127.0.0.1" && cfg.ConnConfig.Host != "localhost" && cfg.ConnConfig.Host != "::1") {
			t.Fatal("dedicated local AI budget DSN target was rejected")
		}
		pool, poolErr := pgxpool.NewWithConfig(ctx, cfg)
		if poolErr != nil {
			t.Fatal("dedicated local AI budget pool could not be created")
		}
		defer pool.Close()
		if pingErr := pool.Ping(ctx); pingErr != nil {
			var pgErr *pgconn.PgError
			if errors.As(pingErr, &pgErr) {
				t.Fatalf("dedicated local AI budget connection rejected by PostgreSQL (SQLSTATE %s)", pgErr.Code)
			}
			if strings.Contains(strings.ToLower(pingErr.Error()), "refused") {
				t.Fatal("dedicated local AI budget connection refused")
			}
			t.Fatalf("dedicated local AI budget connection failed (%T)", pingErr)
		}
		t.Fatal("dedicated local AI budget connector rejected a working DB connection")
	}
	defer store.Close()
	_, err = store.Reserve(ctx, "00000000-0000-4000-8000-000000000000", make([]byte, 32))
	if !errors.Is(err, ErrNotEntitled) {
		t.Fatalf("private reservation RPC returned unexpected result: %v", err)
	}
}

func TestLocalDeveloperFixtureReservationsExceedRequestAndConcurrencyLimits(t *testing.T) {
	if os.Getenv("ARVC_STEP7G3_LOCAL_INTEGRATION") != "1" {
		t.Skip("set ARVC_STEP7G3_LOCAL_INTEGRATION=1 for the local developer fixture exemption check")
	}
	userID := os.Getenv("ARVC_STEP7G3_TEST_USER_ID")
	if userID == "" {
		t.Fatal("local developer test UUID is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	store, err := NewPostgres(ctx, os.Getenv("SUPABASE_AI_BUDGET_DSN"))
	if err != nil {
		t.Fatal("local AI budget store could not connect")
	}
	defer store.Close()
	noEntitlementHash := sha256.Sum256([]byte("step7g3-not-entitled"))
	if _, err := store.ReserveLocalFixture(ctx, "00000000-0000-4000-8000-000000000000", noEntitlementHash[:]); !errors.Is(err, ErrNotEntitled) {
		t.Fatal("local fixture RPC bypassed the AI entitlement check")
	}
	for i := 0; i < 12; i++ {
		hash := sha256.Sum256([]byte(fmt.Sprintf("step7g3-sequential-%d-%d", time.Now().UnixNano(), i)))
		reservation, reserveErr := store.ReserveLocalFixture(ctx, userID, hash[:])
		if reserveErr != nil {
			t.Fatalf("local fixture reservation %d failed: %v", i+1, reserveErr)
		}
		if err := store.Settle(ctx, reservation.ID, Settlement{State: "succeeded"}); err != nil {
			t.Fatal("local fixture reservation settlement failed")
		}
		if i == 0 {
			if _, duplicateErr := store.ReserveLocalFixture(ctx, userID, hash[:]); !errors.Is(duplicateErr, ErrDuplicate) {
				t.Fatal("local fixture reservation did not preserve idempotency")
			}
		}
	}

	const parallel = 10
	type fixtureReservation struct {
		reservation Reservation
		err         error
	}
	results := make(chan fixtureReservation, parallel)
	start := make(chan struct{})
	for i := 0; i < parallel; i++ {
		go func(index int) {
			<-start
			hash := sha256.Sum256([]byte(fmt.Sprintf("step7g3-parallel-%d-%d", time.Now().UnixNano(), index)))
			reservation, reserveErr := store.ReserveLocalFixture(ctx, userID, hash[:])
			results <- fixtureReservation{reservation: reservation, err: reserveErr}
		}(i)
	}
	close(start)
	reservations := make([]Reservation, 0, parallel)
	for i := 0; i < parallel; i++ {
		result := <-results
		if result.err != nil {
			t.Fatalf("parallel local fixture reservation %d failed: %v", i+1, result.err)
		}
		reservations = append(reservations, result.reservation)
	}
	for _, reservation := range reservations {
		if err := store.Settle(ctx, reservation.ID, Settlement{State: "succeeded"}); err != nil {
			t.Fatal("parallel local fixture reservation settlement failed")
		}
	}

	// A normal reservation still counts normally, while the preceding exempt
	// requests must not exhaust the shared daily cap or the user's quota.
	firstHash := sha256.Sum256([]byte(fmt.Sprintf("step7g3-normal-first-%d", time.Now().UnixNano())))
	first, err := store.Reserve(ctx, userID, firstHash[:])
	if err != nil {
		t.Fatalf("ordinary reservation was blocked by exempt Fixture rows: %v", err)
	}
	concurrentHash := sha256.Sum256([]byte(fmt.Sprintf("step7g3-normal-concurrent-%d", time.Now().UnixNano())))
	if _, err := store.Reserve(ctx, userID, concurrentHash[:]); !errors.Is(err, ErrConcurrency) {
		t.Fatal("ordinary reservation did not retain per-user concurrency control")
	}
	if err := store.Settle(ctx, first.ID, Settlement{State: "succeeded"}); err != nil {
		t.Fatal("ordinary reservation settlement failed")
	}
	secondHash := sha256.Sum256([]byte(fmt.Sprintf("step7g3-normal-second-%d", time.Now().UnixNano())))
	second, err := store.Reserve(ctx, userID, secondHash[:])
	if err != nil {
		t.Fatalf("second ordinary daily reservation failed: %v", err)
	}
	if err := store.Settle(ctx, second.ID, Settlement{State: "succeeded"}); err != nil {
		t.Fatal("second ordinary reservation settlement failed")
	}
	thirdHash := sha256.Sum256([]byte(fmt.Sprintf("step7g3-normal-third-%d", time.Now().UnixNano())))
	if _, err := store.Reserve(ctx, userID, thirdHash[:]); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatal("ordinary reservation exceeded the configured daily quota")
	}
}

func TestLocalBudgetReservationsAreAtomicAcrossStoreInstances(t *testing.T) {
	if os.Getenv("ARVC_STEP7G_CONCURRENCY_INTEGRATION") != "1" {
		t.Skip("set ARVC_STEP7G_CONCURRENCY_INTEGRATION=1 for the isolated local Supabase concurrency check")
	}
	ids := strings.Split(os.Getenv("ARVC_STEP7G_TEST_USER_IDS"), ",")
	if len(ids) != 4 {
		t.Fatal("four entitled temporary local users are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	first, err := NewPostgres(ctx, os.Getenv("SUPABASE_AI_BUDGET_DSN"))
	if err != nil {
		t.Fatal("first local budget pool could not connect")
	}
	defer first.Close()
	second, err := NewPostgres(ctx, os.Getenv("SUPABASE_AI_BUDGET_DSN"))
	if err != nil {
		t.Fatal("second local budget pool could not connect")
	}
	defer second.Close()
	stores := []*Postgres{first, second}
	type outcome struct {
		reservation Reservation
		err         error
	}
	reserveConcurrently := func(users []string, salt byte) []outcome {
		results := make(chan outcome, len(users))
		var start sync.WaitGroup
		start.Add(1)
		for i, user := range users {
			go func(index int, userID string) {
				start.Wait()
				hash := make([]byte, 32)
				hash[0], hash[1] = salt, byte(index+1)
				reservation, reserveErr := stores[index%len(stores)].Reserve(ctx, userID, hash)
				results <- outcome{reservation: reservation, err: reserveErr}
			}(i, user)
		}
		start.Done()
		out := make([]outcome, 0, len(users))
		for range users {
			out = append(out, <-results)
		}
		return out
	}
	settleAccepted := func(outcomes []outcome) int {
		accepted := 0
		for _, result := range outcomes {
			if result.err == nil {
				accepted++
				if err := first.Settle(ctx, result.reservation.ID, Settlement{State: "failed_known"}); err != nil {
					t.Fatal("local reservation settlement failed")
				}
			} else if !errors.Is(result.err, ErrConcurrency) {
				t.Fatalf("local reservation returned an unexpected safe error: %v", result.err)
			}
		}
		return accepted
	}
	if accepted := settleAccepted(reserveConcurrently([]string{ids[0], ids[0]}, 1)); accepted != 1 {
		t.Fatalf("same-user concurrency accepted %d requests; want 1", accepted)
	}
	if accepted := settleAccepted(reserveConcurrently(ids[1:], 2)); accepted != 2 {
		t.Fatalf("global concurrency accepted %d requests; want 2", accepted)
	}
}
