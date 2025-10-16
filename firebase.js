import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";
import { getFirestore, collection, onSnapshot, doc, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-functions.js";

// --- グローバル変数 (Firebase関連のみ) ---
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyDAYv5Qm0bfqbHhCLeNp6zjKMty2y7xIIY",
    authDomain: "the-hunt-49493.firebaseapp.com",
    projectId: "the-hunt-49493",
    storageBucket: "the-hunt-49493.firebasestorage.app",
    messagingSenderId: "465769826017",
    appId: "1:465769826017:web:74ad7e62f3ab139cb359a0",
    measurementId: "G-J1KGFE15XP"
};

let userId = localStorage.getItem('user_uuid') || null;
// 他のファイルで定義・初期化される変数: baseMobData, globalMobData, progressUpdateInterval, displayStatus, fetchBaseMobData, mergeMobStatusData, mergeMobLocationsData, updateProgressBars, sortAndRedistribute, closeReportModal
// このファイルで依存するが未定義のDOMElement: DOMElements (modalStatus)

let app = initializeApp(FIREBASE_CONFIG);
let db = getFirestore(app);
let auth = getAuth(app);

let functions = getFunctions(app, "asia-northeast2");
const callUpdateCrushStatus = httpsCallable(functions, 'crushStatusUpdater');

let unsubscribeListeners = [];
// --- /グローバル変数 ---


// --- 認証機能 ---
export const setupAuthentication = (fetchBaseMobData, startRealtimeListeners, displayStatus) => {
    onAuthStateChanged(auth, (user) => {
        if (user) {
            userId = user.uid;
            localStorage.setItem('user_uuid', userId);
            displayStatus(`ユーザー認証成功: ${userId.substring(0, 8)}...`, 'success');
            // baseMobData の状態チェックを外部関数に依存させる
            // NOTE: fetchBaseMobData はグローバルな baseMobData を参照する前提
            if (window.baseMobData && window.baseMobData.length > 0) {
                startRealtimeListeners();
            } else {
                fetchBaseMobData().then(() => startRealtimeListeners());
            }
        } else {
            signInAnonymously(auth).catch((error) => {
                displayStatus(`認証エラー: ${error.message}`, 'error');
            });
        }
    });
};

// --- 受信機能 (リアルタイムリスナー) ---
export const startRealtimeListeners = (mergeMobStatusData, mergeMobLocationsData, updateProgressBars, displayStatus) => {
    // 依存するグローバル変数: progressUpdateInterval
    if (window.progressUpdateInterval) clearInterval(window.progressUpdateInterval);

    unsubscribeListeners.forEach(unsub => unsub());
    unsubscribeListeners = [];
    
    const statusDocs = ['s_latest', 'a_latest', 'f_latest'];
    const mobStatusDataMap = {};

    statusDocs.forEach(docId => {
        const docRef = doc(db, "mob_status", docId);
        const unsubscribe = onSnapshot(docRef, (snapshot) => {
            const data = snapshot.data();
            if (data) {
                mobStatusDataMap[docId] = data;
            }
            mergeMobStatusData(mobStatusDataMap);
            displayStatus("LKT/Memoデータ更新完了。", 'success');
        }, (error) => {
            displayStatus(`MobStatus (${docId}) のリアルタイム同期エラー。`, 'error');
        });
        unsubscribeListeners.push(unsubscribe);
    });

    const unsubscribeLocations = onSnapshot(collection(db, "mob_locations"), (snapshot) => {
        const locationsMap = {};
        snapshot.forEach(doc => {
            const data = doc.data();
            const mobNo = parseInt(doc.id);

            locationsMap[mobNo] = {
                points: data.points || {}
            };
        });
        mergeMobLocationsData(locationsMap);
        displayStatus("湧き潰しデータ更新完了。", 'success');
    }, (error) => {
        displayStatus("MobLocationsのリアルタイム同期エラー。", 'error');
    });
    unsubscribeListeners.push(unsubscribeLocations);

    window.progressUpdateInterval = setInterval(updateProgressBars, 10000);
};

// --- 送信機能 (報告) ---
export const toggleCrushStatus = async (mobNo, locationId, isCurrentlyCulled, displayStatus, globalMobData) => {
    if (!userId) {
        displayStatus("認証が完了していません。", 'error');
        return;
    }

    const action = isCurrentlyCulled ? 'uncrush' : 'crush';
    const mob = globalMobData.find(m => m.No === mobNo);
    if (!mob) return;

    displayStatus(`${mob.Name} (${locationId}) ${action === 'crush' ? '湧き潰し' : '解除'}報告中...`);

    try {
        const result = await callUpdateCrushStatus({
            mob_id: mobNo.toString(),
            point_id: locationId,
            type: action === 'crush' ? 'add' : 'remove',
            userId: userId
        });

        if (result.data?.success) {
            displayStatus(`${mob.Name} の状態を更新しました。`, 'success');
        } else {
            displayStatus(`更新失敗: ${result.data?.message || '不明なエラー'}`, 'error');
        }
    } catch (error) {
        displayStatus(`湧き潰し報告エラー: ${error.message}`, 'error');
    }
};

export const submitReport = async (mobNo, timeISO, memo, globalMobData, closeReportModal, displayStatus) => {
    // 依存するDOMElement: DOMElements.modalStatus (仮に引数で渡すか、内部でアクセスする)
    const DOMElements = window.DOMElements; // 仮にグローバルなDOM要素に依存
    
    if (!userId) {
        displayStatus("認証が完了していません。ページをリロードしてください。", 'error');
        return;
    }
    
    const mob = globalMobData.find(m => m.No === mobNo);
    if (!mob) {
        displayStatus("モブデータが見つかりません。", 'error');
        return;
    }
    
    const killTimeDate = new Date(timeISO);
    if (isNaN(killTimeDate)) {
        displayStatus("時刻形式が不正です。", 'error');
        return;
    }

    DOMElements.modalStatus.textContent = '送信中...';
    displayStatus(`${mob.Name} 討伐時間報告中...`);

    try {
        await addDoc(collection(db, "reports"), {
            mob_id: mobNo.toString(),
            kill_time: killTimeDate,
            reporter_uid: userId,
            memo: memo,
            repop_seconds: mob.REPOP_s
            // mob.Rank の送信は元のコードで削除済み
        });

        closeReportModal();
        displayStatus("報告が完了しました。データ反映を待っています。", 'success');
    } catch (error) {
        console.error("レポート送信エラー:", error);
        DOMElements.modalStatus.textContent = "送信エラー: " + (error.message || "通信失敗");
        displayStatus(`LKT報告エラー: ${error.message || "通信失敗"}`, 'error');
    }
};

// NOTE: グローバル変数の window への登録は、統合ファイルで行う前提とします。
