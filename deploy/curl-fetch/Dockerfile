# web_fetch's fallback transport. curl_cffi pins a curl-impersonate build,
# so the base image stays a plain python-slim.
FROM python:3.12-slim

RUN pip install --no-cache-dir curl_cffi==0.15.0

WORKDIR /app
COPY fetch.py ./fetch.py

USER 65534:65534
EXPOSE 8080
CMD ["python3", "fetch.py"]
