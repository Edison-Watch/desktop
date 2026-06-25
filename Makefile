.PHONY: ci check-em-dash typecheck test

# Full CI gate: em-dash check, typecheck, then tests.
ci:
	npm run ci

# Fail if any tracked source file contains an em dash (U+2014).
check-em-dash:
	npm run check:em-dash

typecheck:
	npm run typecheck

test:
	npm run test
