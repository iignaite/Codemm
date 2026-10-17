FROM python:3.12-slim
RUN pip install --no-cache-dir pytest==8.3.3
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPYCACHEPREFIX=/tmp/pycache \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp
COPY run_tests.py /opt/codemm/run_tests.py
WORKDIR /work/src
