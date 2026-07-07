import zipfile
import os
import sys

def extract_zip(zip_path, extract_path):
    try:
        with zipfile.ZipFile(zip_path, 'r') as z:
            for member in z.infolist():
                # 한글 파일명 처리를 위한 인코딩 시도
                try:
                    filename = member.filename.encode('cp437').decode('cp949')
                except:
                    try:
                        filename = member.filename.encode('cp437').decode('utf-8')
                    except:
                        filename = member.filename
                
                target_path = os.path.join(extract_path, filename)
                
                # 디렉토리 생성
                if member.is_dir():
                    os.makedirs(target_path, exist_ok=True)
                else:
                    # 상위 디렉토리가 없을 수 있으므로 생성
                    os.makedirs(os.path.dirname(target_path), exist_ok=True)
                    with z.open(member) as source, open(target_path, "wb") as target:
                        target.write(source.read())
        return True
    except Exception as e:
        print(f"Error extracting {zip_path}: {e}")
        return False

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python extract.py <zip_path> <extract_path>")
        sys.exit(1)
    
    success = extract_zip(sys.argv[1], sys.argv[2])
    sys.exit(0 if success else 1)
