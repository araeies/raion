"""Catalog service: products from PostgreSQL, prices from the pricing service.

There is no OpenTelemetry code here. "opentelemetry-instrument" (see the Dockerfile) adds
traces, HTTP metrics and log/trace correlation to Flask, psycopg, requests and logging.
"""
import logging
import os
import random

import psycopg
import requests
from flask import Flask, abort, jsonify, request
from waitress import serve

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("catalog")

app = Flask(__name__)
DSN = os.environ["CATALOG_DSN"]
PRICING_URL = os.environ.get("PRICING_URL", "http://pricing-api:8080")
# Share of product requests that fail on purpose (POST /admin/faults), to see alerts fire.
faults = {"failureRate": 0.0}


def price_of(product_id: int) -> float:
    response = requests.get(f"{PRICING_URL}/prices/{product_id}", timeout=2)
    response.raise_for_status()
    return response.json()["price"]


@app.get("/products")
def list_products():
    with psycopg.connect(DSN) as conn:
        rows = conn.execute("SELECT id, name FROM products ORDER BY id LIMIT 20").fetchall()
    log.info("listed %d products", len(rows))
    return jsonify([{"id": r[0], "name": r[1]} for r in rows])


@app.get("/products/<int:product_id>")
def get_product(product_id: int):
    if random.random() < faults["failureRate"]:
        log.error("injected failure for product %d", product_id)
        abort(500)
    with psycopg.connect(DSN) as conn:
        row = conn.execute("SELECT id, name FROM products WHERE id = %s", (product_id,)).fetchone()
    if row is None:
        log.warning("product %d not found", product_id)
        abort(404)
    product = {"id": row[0], "name": row[1], "price": price_of(row[0])}
    log.info("served product %d", product_id)
    return jsonify(product)


@app.post("/admin/faults")
def set_faults():
    faults["failureRate"] = float(request.get_json(force=True).get("failureRate", 0))
    log.warning("failure rate set to %s", faults["failureRate"])
    return jsonify(faults)


@app.get("/healthz")
def healthz():
    return "ok"


if __name__ == "__main__":
    serve(app, host="0.0.0.0", port=5000, threads=8)
