"""runners/env_file.py - hand-parse .env.local KEY=VALUE files.

No external dependencies (no python-dotenv). Skips comments (#), blank lines,
and strips surrounding quotes from values. Returns dict[str, str].
"""
from pathlib import Path


def parse_env_file(path: Path) -> dict[str, str]:
    """Parse .env.local file: KEY=VALUE lines, skip comments/blanks, strip quotes.
    
    Args:
        path: Path to .env.local file.
        
    Returns:
        dict[str, str] of parsed KEY=VALUE pairs.
        
    Raises:
        FileNotFoundError: if path does not exist.
    """
    if not path.exists():
        raise FileNotFoundError(f"Env file not found: {path}")
    
    result = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        # Strip leading/trailing whitespace
        line = line.strip()
        
        # Skip empty lines and comments
        if not line or line.startswith("#"):
            continue
        
        # Split on first '='
        if "=" not in line:
            continue
        
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        
        # Strip surrounding quotes (single or double)
        if (value.startswith('"') and value.endswith('"')) or \
           (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        
        if key:  # Only add if key is non-empty
            result[key] = value
    
    return result
