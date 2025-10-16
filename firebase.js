import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";
import { getFirestore, collection, onSnapshot, doc, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-functions.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDAYv5Qm0bfqbHhCLeNp6zjKMty2y7xIIY",
  authDomain: "the-hunt-49493.firebaseapp.com",
  projectId: "the-hunt-49493",
  storageBucket: "the-hunt-49493.firebasestorage.app",
  messagingSenderId: "465769826017",
  appId: "1:465769826017:web:74ad7e62f3ab139cb359a0",
  measurementId: "G-J1KGFE15XP"
};

let app = initializeApp(FIREBASE_CONFIG);
let db = getFirestore(app);
let auth = getAuth(app);

let functions = getFunctions(app, "asia-northeast2");
const callUpdateCrushStatus = httpsCallable(functions, 'crushStatusUpdater');

let unsubscribeListeners = [];

const mergeMobStatusData = (mobStatusDataMap) => {
    const newData = new Map();
    // (中略: 機能群2のデータ処理ロジックに依存するため、ここではFirebaseからのデータ受信後の呼び出しのみ残す)
    Object.values(mobStatusDataMap).forEach(docData => {
        Object.entries(docData).forEach(([mobId, mobData]) => {
            const mobNo = parseInt(mobId);
            newData.set(mobNo, {
                last_kill_time: mobData.last_kill_time?.seconds || 0,
                prev_kill_time: mobData.prev_kill_time?.seconds || 0,
                last_kill_memo: mobData.last_kill_memo || ''
            });
        });
    });
    globalMobData = globalMobData.map(mob => {
        let mergedMob = { ...mob };
        if (newData.has(mob.No)) {
            const dynamicData = newData.get(mob.No);
            mergedMob.last_kill_time = dynamicData.last_kill_time;
            mergedMob.prev_kill_time = dynamicData.prev_kill_time;
            mergedMob.last_kill_memo = dynamicData.last_kill_memo;
        }
        mergedMob.repopInfo = calculateRepop(mergedMob);
        return mergedMob;
    });
    sortAndRedistribute();
};

const mergeMobLocationsData = (locationsMap) => {
    // (中略: 機能群2のデータ処理ロジックに依存するため、ここではFirebaseからのデータ受信後の呼び出しのみ残す)
    globalMobData = globalMobData.map(mob => {
        let mergedMob = { ...mob };
        const dynamicData = locationsMap[mob.No];
        if (mob.Rank === 'S' && dynamicData) {
            mergedMob.spawn_cull_status = dynamicData.points;
        }
        mergedMob.repopInfo = calculateRepop(mergedMob);
        return mergedMob;
    });
    sortAndRedistribute();
};

const startRealtimeListeners = () => {
    clearInterval(progressUpdateInterval);

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

    progressUpdateInterval = setInterval(updateProgressBars, 10000);
};

const setupAuthentication = () => {
    onAuthStateChanged(auth, (user) => {
        if (user) {
            userId = user.uid;
            localStorage.setItem('user_uuid', userId);
            displayStatus(`ユーザー認証成功: ${userId.substring(0, 8)}...`, 'success');
            if (baseMobData.length > 0) {
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

const toggleCrushStatus = async (mobNo, locationId, isCurrentlyCulled) => {
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
            type: action === 'crush' ? 'add' : 'remove', // Cloud Functionの引数名に合わせる
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

const submitReport = async (mobNo, timeISO, memo) => {
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

    // DOMElements と displayStatus の依存があるため、UI操作部分はここでは仮に残す
    // DOMElements.modalStatus.textContent = '送信中...'; 
    displayStatus(`${mob.Name} 討伐時間報告中...`);

    try {
        await addDoc(collection(db, "reports"), {
            mob_id: mobNo.toString(),
            kill_time: killTimeDate,
            reporter_uid: userId,
            memo: memo,
            repop_seconds: mob.REPOP_s
        });

        // closeReportModal(); // 機能群4のUI機能
        displayStatus("報告が完了しました。データ反映を待っています。", 'success');
    } catch (error) {
        console.error("レポート送信エラー:", error);
        // DOMElements.modalStatus.textContent = "送信エラー: " + (error.message || "通信失敗"); // 機能群4のUI機能
        displayStatus(`LKT報告エラー: ${error.message || "通信失敗"}`, 'error');
    }
};
