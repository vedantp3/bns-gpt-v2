import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
# legal_ai opens statutory_search.db and app mounts static/ by relative path.
os.chdir(ROOT)

# Keep imports working without real credentials; tests stub every external call.
os.environ.setdefault("SUPABASE_URL", "http://localhost:54321")
os.environ.setdefault("SUPABASE_KEY", "test-key")
os.environ.setdefault("GROQ_API_KEY", "test-key")
