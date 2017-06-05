#!/usr/bin/env bash
# This script runs umd tests and cleans up after them while preserving the `return_code` for CI
# UMD tests should be only run after the commonjs build cause they reuse some of the commonjs build artefacts
run-s substitute_umd_bundle run_mocha
return_code=$?
npm run clean
exit $return_code
