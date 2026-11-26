# One image for all three team agents; the team is chosen by environment variables (see app.py).
# AgentCore Runtime requires an ARM64 image that serves POST /invocations and GET /ping on port 8080.
FROM --platform=linux/arm64 python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
RUN useradd --system --uid 10001 agent
USER agent
ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "app.py"]
