GOOSE ?= goose
MIGRATIONS_DIR=migrations
DB_URL ?= postgres://beluga:beluga@localhost:5432/beluga?sslmode=disable

.PHONY: build run test lint migrate-up migrate-down tidy

build:
	go build -o bin/beluga ./cmd/beluga

run: build
	./bin/beluga --config configs/beluga.yaml

test:
	go test -v ./...

lint:
	golangci-lint run ./...

tidy:
	go mod tidy

migrate-up:
	$(GOOSE) -dir $(MIGRATIONS_DIR) postgres "$(DB_URL)" up

migrate-down:
	$(GOOSE) -dir $(MIGRATIONS_DIR) postgres "$(DB_URL)" down

migrate-status:
	$(GOOSE) -dir $(MIGRATIONS_DIR) postgres "$(DB_URL)" status
