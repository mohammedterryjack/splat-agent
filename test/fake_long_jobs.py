#!/usr/bin/env python3
"""Stand-in for long_jobs.py in tests: records each call as one JSON line in $FAKE_LONG_JOBS_LOG."""
import json, os, sys
with open(os.environ["FAKE_LONG_JOBS_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\n")
if os.environ.get("FAKE_LONG_JOBS_FAIL"):
    sys.exit("long job is already failed")
print("ok")
