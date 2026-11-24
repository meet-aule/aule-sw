# Build from the repository root: docker build -f apps/agent/Dockerfile .
FROM python:3.14-slim@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f AS build
COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY apps/agent/pyproject.toml apps/agent/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY apps/agent/src ./src
RUN uv sync --locked --no-dev --no-editable

FROM python:3.14-slim@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f
RUN useradd --system --uid 10001 --home-dir /tmp aule
COPY --from=build /app/.venv /app/.venv
COPY contracts /app/contracts
ENV PATH=/app/.venv/bin:$PATH \
    AULE_CONTRACTS_DIR=/app/contracts \
    HOME=/tmp \
    PYTHONUNBUFFERED=1
USER aule
# The commit it is built from (RELEASING.md). Last, so a new one rebuilds no layer.
ARG AULE_COMMIT=unknown
ENV AULE_COMMIT=$AULE_COMMIT
CMD ["python", "-m", "aule_agent.worker", "start"]
