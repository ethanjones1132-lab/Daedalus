#!/usr/bin/env bash
# Starts the full 2c pipeline once the baseline pre-pass (run_2c.sh pre) has written its last log line.
until grep -q "pre-baselines finished" /e/AI/role-adapters/logs/2c.log 2>/dev/null; do sleep 30; done
exec bash "$(dirname "$0")/run_2c.sh" full
