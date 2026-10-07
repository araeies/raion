// Pricing service: prices products, caching them in Redis.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/redis/go-redis/extra/redisotel/v9"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

func main() {
	healthcheck := flag.Bool("healthcheck", false, "check that the service answers, then exit")
	flag.Parse()
	if *healthcheck {
		res, err := http.Get("http://127.0.0.1:8080/healthz")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	shutdown, err := setupOTel(ctx)
	if err != nil {
		log.Fatalf("opentelemetry: %v", err)
	}
	defer func() { _ = shutdown(context.Background()) }()

	// Log records carry the trace and span of the request when given its context.
	logger := otelslog.NewLogger("pricing-api")

	cache := redis.NewClient(&redis.Options{Addr: os.Getenv("REDIS_ADDR")})
	if err := redisotel.InstrumentTracing(cache); err != nil {
		log.Fatalf("redis tracing: %v", err)
	}

	mux := http.NewServeMux()
	// otelhttp records the matched pattern ("/prices/{id}") as the route, not each product's URL.
	mux.HandleFunc("GET /prices/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.Atoi(r.PathValue("id"))
		if err != nil {
			http.Error(w, "bad product id", http.StatusBadRequest)
			return
		}
		price, cached, err := priceOf(r.Context(), cache, id)
		if err != nil {
			logger.ErrorContext(r.Context(), "pricing failed", "product", id, "error", err)
			http.Error(w, "pricing failed", http.StatusInternalServerError)
			return
		}
		logger.InfoContext(r.Context(), "priced product", "product", id, "cached", cached)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": id, "price": price})
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	server := &http.Server{
		Addr:              ":8080",
		Handler:           otelhttp.NewHandler(mux, "pricing-api"),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	slog.Info("pricing-api listening on :8080")
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// priceOf returns a product's price from the cache, or computes and caches it.
func priceOf(ctx context.Context, cache *redis.Client, id int) (float64, bool, error) {
	key := fmt.Sprintf("price:%d", id)
	if value, err := cache.Get(ctx, key).Float64(); err == nil {
		return value, true, nil
	} else if !errors.Is(err, redis.Nil) {
		return 0, false, err
	}
	// Pretend pricing takes a little work.
	time.Sleep(time.Duration(5+rand.IntN(20)) * time.Millisecond)
	price := float64(100+id*7%90) - 0.01
	// Short expiry, so the cache keeps being exercised.
	if err := cache.Set(ctx, key, price, 30*time.Second).Err(); err != nil {
		return 0, false, err
	}
	return price, false, nil
}
