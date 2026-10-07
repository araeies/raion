"""Steady, varied traffic through the edge: lists, single products and the odd missing one."""
import random
import time
import urllib.error
import urllib.request

BASE = "http://edge:8080"

while True:
    path = random.choice(
        ["/products"] + [f"/products/{random.randint(1, 50)}"] * 6 + ["/products/999"]
    )
    try:
        urllib.request.urlopen(BASE + path, timeout=5).read()
    except urllib.error.HTTPError:
        pass  # 404 and injected 500 are part of the traffic
    except OSError as error:
        print("request failed:", error, flush=True)
    time.sleep(0.3)
