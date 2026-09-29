"""Verify imports and report missing setting names, never their values."""
from config import Settings
from pipeline import run_conversation
from importlib.metadata import version

print("Python voice imports OK")
for package in ("pipecat-ai", "aiortc", "fastapi"):
    print(f"{package}: {version(package)}")
missing = Settings.load().missing()
print("Missing configuration: " + (", ".join(missing) if missing else "none"))
