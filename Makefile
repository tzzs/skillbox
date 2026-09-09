.DEFAULT_GOAL := help

.PHONY: help install build typecheck test lint format format-check check web-dev web-preview verify

help: ## Show available development commands
	@node -e "console.log('Skillbox development commands:\n  make install       Install locked dependencies\n  make build         Build all packages and the web application\n  make typecheck     Run TypeScript checks\n  make test          Run all tests\n  make lint          Check linting and formatting\n  make format        Format the repository\n  make format-check  Check formatting only\n  make check         Run lint, typecheck, and tests\n  make web-dev       Start the Vite development server\n  make web-preview   Preview the production web build\n  make verify        Verify the packaged CLI artifact')"

install: ## Install dependencies from the lockfile
	pnpm install --frozen-lockfile

build: ## Build all packages and the web application
	pnpm build

typecheck: ## Run TypeScript checks
	pnpm typecheck

test: ## Run all tests
	pnpm test

lint: ## Check linting and formatting
	pnpm lint

format: ## Format the repository
	pnpm format

format-check: ## Check formatting only
	pnpm format:check

check: lint typecheck test ## Run the standard quality gate

web-dev: ## Start the Vite development server
	pnpm --filter @skillbox/web dev

web-preview: ## Preview the production web build
	pnpm --filter @skillbox/web preview

verify: build ## Verify the packaged CLI artifact
	node scripts/verify-package.mjs
