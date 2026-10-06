FROM ubuntu@sha256:f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b
ARG BENCH_UID=1001
ARG BENCH_GID=1001
RUN apt-get update \
    && apt-get install --yes --no-install-recommends bash ca-certificates git procps time zsh \
    && rm -rf /var/lib/apt/lists/*
RUN if ! getent group "$BENCH_GID" > /dev/null; then groupadd --gid "$BENCH_GID" ballinfixture; fi \
    && if ! getent passwd "$BENCH_UID" > /dev/null; then useradd --uid "$BENCH_UID" --gid "$BENCH_GID" --create-home --shell /bin/bash ballinfixture; fi
CMD ["/bin/sleep", "infinity"]
