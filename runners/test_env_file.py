"""runners/test_env_file.py - unit tests for env_file parser."""
import tempfile
from pathlib import Path

import pytest

from env_file import parse_env_file


class TestParseEnvFile:
    """Test parse_env_file() with various .env.local formats."""

    def test_happy_path_simple_vars(self) -> None:
        """Parse simple KEY=VALUE lines."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env.local", delete=False, encoding="utf-8") as f:
            f.write("KEY1=value1\n")
            f.write("KEY2=value2\n")
            f.flush()
            path = Path(f.name)
        
        try:
            result = parse_env_file(path)
            assert result == {"KEY1": "value1", "KEY2": "value2"}
        finally:
            path.unlink()

    def test_skip_comments(self) -> None:
        """Skip lines starting with #."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env.local", delete=False, encoding="utf-8") as f:
            f.write("# This is a comment\n")
            f.write("KEY1=value1\n")
            f.write("# Another comment\n")
            f.write("KEY2=value2\n")
            f.flush()
            path = Path(f.name)
        
        try:
            result = parse_env_file(path)
            assert result == {"KEY1": "value1", "KEY2": "value2"}
        finally:
            path.unlink()

    def test_skip_blank_lines(self) -> None:
        """Skip empty and whitespace-only lines."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env.local", delete=False, encoding="utf-8") as f:
            f.write("KEY1=value1\n")
            f.write("\n")
            f.write("   \n")
            f.write("KEY2=value2\n")
            f.flush()
            path = Path(f.name)
        
        try:
            result = parse_env_file(path)
            assert result == {"KEY1": "value1", "KEY2": "value2"}
        finally:
            path.unlink()

    def test_strip_double_quotes(self) -> None:
        """Strip surrounding double quotes from values."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env.local", delete=False, encoding="utf-8") as f:
            f.write('KEY1="value with spaces"\n')
            f.write('KEY2="another value"\n')
            f.flush()
            path = Path(f.name)
        
        try:
            result = parse_env_file(path)
            assert result == {"KEY1": "value with spaces", "KEY2": "another value"}
        finally:
            path.unlink()

    def test_strip_single_quotes(self) -> None:
        """Strip surrounding single quotes from values."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env.local", delete=False, encoding="utf-8") as f:
            f.write("KEY1='value with spaces'\n")
            f.write("KEY2='another value'\n")
            f.flush()
            path = Path(f.name)
        
        try:
            result = parse_env_file(path)
            assert result == {"KEY1": "value with spaces", "KEY2": "another value"}
        finally:
            path.unlink()

    def test_no_strip_mismatched_quotes(self) -> None:
        """Do not strip mismatched quotes."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env.local", delete=False, encoding="utf-8") as f:
            f.write('KEY1="value\'\n')
            f.write("KEY2='value\"\n")
            f.flush()
            path = Path(f.name)
        
        try:
            result = parse_env_file(path)
            assert result == {"KEY1": '"value\'', "KEY2": '\'value"'}
        finally:
            path.unlink()

    def test_whitespace_around_key_value(self) -> None:
        """Strip whitespace around key and value."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env.local", delete=False, encoding="utf-8") as f:
            f.write("  KEY1  =  value1  \n")
            f.write("KEY2=value2\n")
            f.flush()
            path = Path(f.name)
        
        try:
            result = parse_env_file(path)
            assert result == {"KEY1": "value1", "KEY2": "value2"}
        finally:
            path.unlink()

    def test_multiple_equals_in_value(self) -> None:
        """Handle values with multiple '=' characters."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env.local", delete=False, encoding="utf-8") as f:
            f.write("KEY1=value=with=equals\n")
            f.write("KEY2=a=b=c\n")
            f.flush()
            path = Path(f.name)
        
        try:
            result = parse_env_file(path)
            assert result == {"KEY1": "value=with=equals", "KEY2": "a=b=c"}
        finally:
            path.unlink()

    def test_empty_value(self) -> None:
        """Handle empty values."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env.local", delete=False, encoding="utf-8") as f:
            f.write("KEY1=\n")
            f.write("KEY2=value\n")
            f.flush()
            path = Path(f.name)
        
        try:
            result = parse_env_file(path)
            assert result == {"KEY1": "", "KEY2": "value"}
        finally:
            path.unlink()

    def test_file_not_found(self) -> None:
        """Raise FileNotFoundError for missing file."""
        path = Path("/nonexistent/path/.env.local")
        with pytest.raises(FileNotFoundError):
            parse_env_file(path)

    def test_keycloak_and_gcp_vars(self) -> None:
        """Parse realistic Keycloak and GCP env vars."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env.local", delete=False, encoding="utf-8") as f:
            f.write("# Keycloak\n")
            f.write("KEYCLOAK_TOKEN_URL=https://keycloak.example.com/token\n")
            f.write("KEYCLOAK_ISSUER=https://keycloak.example.com/realms/tenetx\n")
            f.write("KEYCLOAK_CLIENT_ID=tenetx-mimic-backend\n")
            f.write('KEYCLOAK_CLIENT_SECRET="super-secret-value"\n')
            f.write("\n")
            f.write("# GCP WIF\n")
            f.write("GCP_PROJECT_ID=tenetx-qa-scores\n")
            f.write("GCP_WIF_CREDENTIAL_CONFIG=/path/to/cred-config.json\n")
            f.write("GOOGLE_APPLICATION_CREDENTIALS=/path/to/cred-config.json\n")
            f.flush()
            path = Path(f.name)
        
        try:
            result = parse_env_file(path)
            assert result["KEYCLOAK_TOKEN_URL"] == "https://keycloak.example.com/token"
            assert result["KEYCLOAK_ISSUER"] == "https://keycloak.example.com/realms/tenetx"
            assert result["KEYCLOAK_CLIENT_ID"] == "tenetx-mimic-backend"
            assert result["KEYCLOAK_CLIENT_SECRET"] == "super-secret-value"
            assert result["GCP_PROJECT_ID"] == "tenetx-qa-scores"
            assert result["GCP_WIF_CREDENTIAL_CONFIG"] == "/path/to/cred-config.json"
            assert result["GOOGLE_APPLICATION_CREDENTIALS"] == "/path/to/cred-config.json"
        finally:
            path.unlink()

    def test_skip_lines_without_equals(self) -> None:
        """Skip lines that don't contain '='."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env.local", delete=False, encoding="utf-8") as f:
            f.write("KEY1=value1\n")
            f.write("INVALID_LINE_NO_EQUALS\n")
            f.write("KEY2=value2\n")
            f.flush()
            path = Path(f.name)
        
        try:
            result = parse_env_file(path)
            assert result == {"KEY1": "value1", "KEY2": "value2"}
        finally:
            path.unlink()
