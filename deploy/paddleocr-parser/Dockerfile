# PaddleOCR /parse 파서 (CPU 모드) — N100급 미니PC에서 동작
# 최초 기동 시 PP-StructureV3 모델을 다운로드하므로 첫 요청이 수 분 걸릴 수 있음.
# 모델 캐시는 볼륨(/root/.paddlex)으로 영속화 권장 (docker-compose.yml 참조).
FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

EXPOSE 13430
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "13430"]
