# kimmi: one binary. `make up` for the full Docker stack, `make dev` to hack on it.
include .env
export

VERSION ?= dev
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
LDFLAGS := -X main.version=$(VERSION) -X main.commit=$(COMMIT)

LOCAL_DB := postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@localhost:25432/$(POSTGRES_DB)?sslmode=disable
LOCAL_S3 := http://localhost:28333

.env:
	cp .env.example .env

.PHONY: up down deps build web sdk server dev dev-web test loadtest seed clean

up: ## Build and start everything in Docker
	docker compose up --build -d
	@echo "kimmi is starting on $(KIMMI_PUBLIC_URL)"

down:
	docker compose down

deps: ## Postgres and SeaweedFS only, for local development
	docker compose up -d postgres seaweedfs

sdk:
	pnpm --filter @kimmi/browser build

web: sdk
	pnpm --filter @kimmi/web build
	rm -rf internal/webui/dist && mkdir -p internal/webui/dist
	cp -R web/dist/. internal/webui/dist/
	cp sdk/browser/dist/kimmi.js internal/webui/dist/kimmi.js
	cp sdk/browser/dist/kimmi-feedback.js internal/webui/dist/kimmi-feedback.js

server:
	CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o bin/kimmi ./cmd/kimmi

build: web server ## The single binary, dashboard embedded, at bin/kimmi

dev: deps server ## Run the server against the compose Postgres and SeaweedFS
	KIMMI_DATABASE_URL="$(LOCAL_DB)" KIMMI_STORAGE=s3 KIMMI_S3_ENDPOINT="$(LOCAL_S3)" bin/kimmi serve

dev-web: ## Dashboard with hot reload on :5210, proxying to the server
	pnpm --filter @kimmi/web dev --port 5210

test:
	go test ./...
	pnpm --filter @kimmi/browser test
	pnpm --filter @kimmi/web test

loadtest: server ## make loadtest KEY=km_pub_... [SESSIONS=2000 CONCURRENCY=200]
	bin/kimmi loadgen --host $(KIMMI_PUBLIC_URL) --key $(KEY) --sessions $(or $(SESSIONS),2000) --concurrency $(or $(CONCURRENCY),200)

seed: server ## make seed KEY=km_pub_... [VISITS=150000 RECORDED=15000 DAYS=60]; the server needs KIMMI_TEST_HOOKS=1 and KIMMI_INGEST_RATE=0
	bin/kimmi seed --host $(KIMMI_PUBLIC_URL) --key $(KEY) --visits $(or $(VISITS),150000) --recorded $(or $(RECORDED),15000) --days $(or $(DAYS),60)

clean:
	rm -rf bin data web/dist sdk/browser/dist
