PI_AGENT_DIR ?= $(HOME)/.pi/agent
PI_EXTENSIONS_DIR ?= $(PI_AGENT_DIR)/extensions

.DEFAULT_GOAL := help

.PHONY: help apply verify-apply check

help:
	@echo "make apply         Link the mutable checkout into $(PI_EXTENSIONS_DIR)"
	@echo "make verify-apply  Verify the local extension link"
	@echo "make check         Run tests, typechecking, and package checks"

apply:
	mkdir -p "$(PI_EXTENSIONS_DIR)"
	ln -sfn "$(CURDIR)" "$(PI_EXTENSIONS_DIR)/model-tier-router"
	$(MAKE) verify-apply
	@echo "Restart Pi to discover the newly linked extension."

verify-apply:
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/model-tier-router")" = "$(CURDIR)"

check:
	npm run check
