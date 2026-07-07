# crawl4alio 본체 — 수집·변환 CLI (kordoc npm 내장)
# 사용: docker compose run --rm app npm run sync:alio
FROM node:20-slim

# python3: ZIP 압축 해제(extract_zip.py, 한글 파일명 CP949 처리)용
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

# 한글 파일명 처리를 위한 UTF-8 로케일
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY collection ./collection
COPY ocrtomarkdown ./ocrtomarkdown

# data/는 호스트 볼륨으로 마운트 (git clone한 저장소의 data/에 시드 포함)
CMD ["node", "collection/check_services.js"]
