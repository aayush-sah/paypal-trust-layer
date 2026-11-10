import os
from dotenv import load_dotenv, dotenv_values, find_dotenv

system_key = os.getenv("ANTHROPIC_API_KEY")
file_key = dotenv_values(find_dotenv()).get("ANTHROPIC_API_KEY")
load_dotenv()
key = os.getenv("ANTHROPIC_API_KEY")

print(".env file found at:", find_dotenv() or "NOT FOUND")
print("Key written in .env:", file_key is not None)
print("Key already set in Windows environment:", system_key is not None)
if system_key and file_key and system_key != file_key:
    print("WARNING: Windows key differs from .env key. The Windows one wins.")

if key:
    print("Key starts with:", key[:7], "| length:", len(key))
    print("Has spaces or quotes:", any(c in key for c in ' "\''))

try:
    from anthropic import Anthropic
    reply = Anthropic(timeout=10.0, max_retries=0).messages.create(
        model=os.getenv("EXPLAIN_MODEL", "claude-haiku-5-5"),
        max_tokens=20,
        messages=[{"role": "user", "content": "Say hi in three words."}],
    )
    print("SUCCESS:", reply.content[0].text)
except Exception as e:
    print("FAILED:", type(e).__name__, "-", str(e)[:200])