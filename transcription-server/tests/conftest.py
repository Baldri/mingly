"""Makes the service modules importable from the test files.

The service is a flat package-less directory (same shape as `rag-server`), so
the tests need its directory on `sys.path`. Doing it here rather than in each
test file keeps the import working no matter which directory pytest is
started from.
"""

import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parent.parent

if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))
