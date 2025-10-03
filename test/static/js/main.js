// static/js/main.js
const socket = io();

document.addEventListener('DOMContentLoaded', () => {
    // ----------------------------------------
    // 1. 音声認識 (Web Speech API)
    // ----------------------------------------
    const startSttButton = document.getElementById('start-stt');
    const copyTextButton = document.getElementById('copy-text');
    const sttStatus = document.getElementById('stt-status');
    const textOutput = document.getElementById('text-output');

    // ブラウザがWeb Speech APIをサポートしているか確認
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.lang = 'ja-JP';
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;

        recognition.onstart = () => {
            sttStatus.textContent = '話してください... (録音中)';
            startSttButton.disabled = true;
        };

        recognition.onresult = (event) => {
            const speechResult = event.results[0][0].transcript;
            textOutput.value += speechResult + ' ';
            sttStatus.textContent = '認識完了。';
        };

        recognition.onend = () => {
            startSttButton.disabled = false;
            sttStatus.textContent = '待機中...';
        };

        recognition.onerror = (event) => {
            sttStatus.textContent = `エラー: ${event.error}`;
            startSttButton.disabled = false;
        };

        startSttButton.onclick = () => {
            recognition.start();
        };

        copyTextButton.onclick = () => {
            navigator.clipboard.writeText(textOutput.value).then(() => {
                alert('テキストがクリップボードにコピーされました！');
            });
        };
    } else {
        sttStatus.textContent = 'お使いのブラウザは音声認識をサポートしていません。';
        startSttButton.disabled = true;
    }


    // ----------------------------------------
    // 2. Webカメラと顔認識 (隠し機能)
    // ----------------------------------------
    const startCameraButton = document.getElementById('start-camera');
    const cameraFeed = document.getElementById('camera-feed');
    const cameraCanvas = document.getElementById('camera-canvas');
    const cameraStatus = document.getElementById('camera-status');
    const dangerAlert = document.getElementById('danger-alert');
    let stream = null;
    let isMonitoring = false;

    // A. カメラ起動
    startCameraButton.onclick = () => {
        if (isMonitoring) {
            // 停止処理
            stream.getTracks().forEach(track => track.stop());
            cameraFeed.srcObject = null;
            isMonitoring = false;
            startCameraButton.textContent = 'Webカメラ起動 / 監視開始';
            cameraStatus.textContent = 'カメラはオフです。';
        } else {
            // 起動処理
            navigator.mediaDevices.getUserMedia({ video: true })
                .then(mediaStream => {
                    stream = mediaStream;
                    cameraFeed.srcObject = mediaStream;
                    cameraFeed.onloadedmetadata = () => {
                        cameraFeed.play();
                        isMonitoring = true;
                        startCameraButton.textContent = 'Webカメラ停止 / 監視停止';
                        cameraStatus.textContent = 'カメラ監視中...';
                        sendFrameToSocket(); // フレーム送信を開始
                    };
                })
                .catch(err => {
                    console.error("カメラアクセスエラー: ", err);
                    cameraStatus.textContent = 'カメラアクセスが拒否されました。';
                });
        }
    };

    // B. フレーム送信ロジック
    function sendFrameToSocket() {
        if (!isMonitoring) return;

        const context = cameraCanvas.getContext('2d');
        cameraCanvas.width = cameraFeed.videoWidth;
        cameraCanvas.height = cameraFeed.videoHeight;

        // Canvasに現在のフレームを描画
        context.drawImage(cameraFeed, 0, 0, cameraCanvas.width, cameraCanvas.height);

        // 画像データをBase64形式で取得
        const dataURL = cameraCanvas.toDataURL('image/jpeg', 0.5); // 0.5は画質 (処理負荷軽減のため)

        // SocketIOでサーバーに送信
        socket.emit('video_frame', { data: dataURL });

        // 100ミリ秒ごとに再実行 (1秒間に約10フレーム)
        setTimeout(sendFrameToSocket, 100); 
    }

    // C. サーバーからの通知受信
    socket.on('notification', (data) => {
        dangerAlert.textContent = data.message;
        dangerAlert.style.display = 'block';

        // 5秒後にアラートを非表示にする
        setTimeout(() => {
            dangerAlert.style.display = 'none';
        }, 5000);
    });
    
    // ----------------------------------------
    // 3. 顔認識データ管理
    // ----------------------------------------
    const addFaceForm = document.getElementById('add-face-form');
    const knownFacesList = document.getElementById('known-faces-list');

    // 登録人物リストの取得と表示
    function loadKnownFaces() {
        fetch('/list_faces')
            .then(res => res.json())
            .then(data => {
                knownFacesList.innerHTML = '';
                if (data.faces) {
                    data.faces.forEach(face => {
                        const li = document.createElement('li');
                        li.textContent = `${face.name} (ID: ${face.id})`;

                        // 削除ボタン
                        const deleteBtn = document.createElement('button');
                        deleteBtn.textContent = '削除';
                        deleteBtn.style.marginLeft = '10px';
                        deleteBtn.onclick = () => deleteFace(face.id);
                        
                        li.appendChild(deleteBtn);
                        knownFacesList.appendChild(li);
                    });
                }
            });
    }

    // 削除処理
    function deleteFace(faceId) {
        if (!confirm('この人物を削除してもよろしいですか？')) return;

        fetch(`/delete_face/${faceId}`, { method: 'POST' })
            .then(res => res.json())
            .then(data => {
                alert(data.message);
                loadKnownFaces(); // リストを更新
            });
    }

    // 新規登録処理
    addFaceForm.onsubmit = (e) => {
        e.preventDefault();

        const formData = new FormData();
        const fileInput = document.getElementById('photo-file');
        const personName = document.getElementById('person-name').value;

        // 複数ファイルのアップロードに対応 (ただし、この例では最初のファイルのみ処理)
        if (fileInput.files.length > 0) {
            formData.append('file', fileInput.files[0]); 
        } else {
             alert('ファイルを添付してください。');
             return;
        }

        formData.append('name', personName);

        fetch('/add_face', {
            method: 'POST',
            body: formData
        })
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                alert(`登録エラー: ${data.error}`);
            } else {
                alert(`登録成功: ${data.name}`);
                addFaceForm.reset();
                loadKnownFaces(); // リストを更新
            }
        })
        .catch(err => {
            console.error('登録中にエラーが発生しました:', err);
            alert('登録中にエラーが発生しました。サーバーを確認してください。');
        });
    };

    // ページロード時にリストを読み込む
    loadKnownFaces(); 
});