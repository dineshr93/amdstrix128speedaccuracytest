# AMD Dash — local LLM benchmark notebook, containerized.
# Build:  docker build -t amd-dash .
# Run:    docker run --rm -p 5000:5000 -v "$HOME/amddash:/data/amddash" amd-dash
#         (mount the whole ~/amddash directory, not the single data file —
#          atomic rename over a file mount point fails with EBUSY)

FROM python:3.12-slim

WORKDIR /app

# Install dependencies first so source edits don't bust the pip layer cache.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application source into the image
COPY app.py .
COPY templates/ templates/
COPY static/ static/

# Create a non-root user. The data dir is bind-mounted from the host; run as
# the host UID/GID (set via compose `user:`) so files written into the mount
# stay owned by the host user instead of root.
RUN groupadd --gid 1000 amddash \
    && useradd --create-home --uid 1000 --gid 1000 amddash \
    && chown -R 1000:1000 /app

# Data is mounted at /data/amddash via AMDASH_DATA_FILE.
# The directory is created so the mount target always exists.
ENV AMDASH_DATA_FILE=/data/amddash/data.yaml

EXPOSE 5000

# Bind to 0.0.0.0 inside the container so the published port works.
ENV AMDASH_HOST=0.0.0.0
ENV AMDASH_PORT=5000

USER amddash

# Production WSGI server (never the Werkzeug dev server).
# 1 worker: the store is a single YAML file guarded by an flock; more workers
# buy nothing for a local single-user app.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/healthz', timeout=3)"

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "4", "--access-logfile", "-", "app:app"]
