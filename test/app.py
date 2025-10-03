# app.py
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
import config
import numpy as np
import base64
import cv2
import face_recognition
import sqlite3
import json

app = Flask(__name__)
app.config.from_object(config)
socketio = SocketIO(app, cors_allowed_origins="*") # 開発中はCORSを許可

# --- データベース初期化 (顔データ保存用) ---
def init_db():
    conn = sqlite3.connect(config.FACE_DB_PATH)
    c = conn.cursor()
    # face_encodingはJSON形式で保存 (128次元のリスト)
    c.execute('''
        CREATE TABLE IF NOT EXISTS known_faces (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            face_encoding TEXT NOT NULL
        )
    ''')
    conn.commit()
    conn.close()
init_db()

# 既知の顔データをメモリにロード
KNOWN_FACE_ENCODINGS = []
KNOWN_FACE_NAMES = []
def load_known_faces():
    global KNOWN_FACE_ENCODINGS, KNOWN_FACE_NAMES
    conn = sqlite3.connect(config.FACE_DB_PATH)
    c = conn.cursor()
    c.execute("SELECT name, face_encoding FROM known_faces")
    rows = c.fetchall()
    KNOWN_FACE_ENCODINGS = [np.array(json.loads(row[1])) for row in rows]
    KNOWN_FACE_NAMES = [row[0] for row in rows]
    conn.close()
load_known_faces()


# --- ルート定義 ---

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/list_faces', methods=['GET'])
def list_faces():
    """登録されている人物リストを返すAPI"""
    conn = sqlite3.connect(config.FACE_DB_PATH)
    c = conn.cursor()
    c.execute("SELECT id, name FROM known_faces")
    data = [{"id": row[0], "name": row[1]} for row in c.fetchall()]
    conn.close()
    return jsonify({"faces": data})

@app.route('/delete_face/<int:face_id>', methods=['POST'])
def delete_face(face_id):
    """特定の人物のデータを削除するAPI"""
    conn = sqlite3.connect(config.FACE_DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM known_faces WHERE id=?", (face_id,))
    conn.commit()
    conn.close()
    load_known_faces() # データを再ロード
    return jsonify({"success": True, "message": f"ID {face_id} の人物データを削除しました。"})

@app.route('/add_face', methods=['POST'])
def add_face():
    """新しい人物の顔データを学習・登録するAPI"""
    if 'file' not in request.files or 'name' not in request.form:
        return jsonify({"error": "ファイルと人物名が必要です"}), 400

    file = request.files['file']
    person_name = request.form['name']

    # 1. ファイルをnumpy配列として読み込み
    try:
        image = face_recognition.load_image_file(file)
    except Exception as e:
        return jsonify({"error": f"画像ファイルの読み込みエラー: {e}"}), 500

    # 2. 顔のエンコーディングを取得
    face_encodings = face_recognition.face_encodings(image)

    if not face_encodings:
        return jsonify({"error": "画像内に顔が検出されませんでした"}), 400

    if len(KNOWN_FACE_ENCODINGS) >= 10:
        return jsonify({"error": "登録できる人数は10人までです"}), 403

    # 3. データベースに保存
    new_encoding = face_encodings[0]
    conn = sqlite3.connect(config.FACE_DB_PATH)
    c = conn.cursor()
    c.execute("INSERT INTO known_faces (name, face_encoding) VALUES (?, ?)", 
              (person_name, json.dumps(new_encoding.tolist())))
    conn.commit()
    conn.close()

    load_known_faces() # データを再ロード
    return jsonify({"success": True, "name": person_name, "message": "顔の特徴量を登録しました"})


# --- SocketIO (リアルタイム通信) ---

@socketio.on('video_frame')
def handle_video_frame(data):
    """
    クライアントから送られたWebカメラのフレームを処理し、顔認識を行う
    """
    # 1. Base64データをデコード
    encoded_data = data['data'].split(',')[1]
    nparr = np.frombuffer(base64.b64decode(encoded_data), np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    # 2. 顔の検出と認識 (処理負荷軽減のため、フレームをリサイズすることが推奨)
    small_frame = cv2.resize(frame, (0, 0), fx=0.25, fy=0.25)
    rgb_small_frame = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)

    face_locations = face_recognition.face_locations(rgb_small_frame)
    face_encodings = face_recognition.face_encodings(rgb_small_frame, face_locations)
    
    # 3. 既知の顔と比較
    for face_encoding in face_encodings:
        # compare_faces (閾値 0.6 を使用)
        matches = face_recognition.compare_faces(KNOWN_FACE_ENCODINGS, face_encoding, tolerance=0.6)
        name = "Unknown"

        face_distances = face_recognition.face_distance(KNOWN_FACE_ENCODINGS, face_encoding)
        if len(face_distances) > 0:
            best_match_index = np.argmin(face_distances)
            
            if matches[best_match_index]:
                name = KNOWN_FACE_NAMES[best_match_index]
                
                # 4. 危険人物を検出した場合、クライアントに通知を送信
                emit('notification', {'message': f"⚠️ 危険人物が検出されました: {name}"}, broadcast=False)
                print(f"Detected: {name}") 
                return # 検出したら他の処理をスキップ
                
    # 検出されなかった場合も通知を返しても良い (例: 'clear')
    # emit('notification', {'message': 'clear'}, broadcast=False)


if __name__ == '__main__':
    socketio.run(app, debug=True, allow_unsafe_werkzeug=True) # 開発用