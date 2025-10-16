// --- 定数定義 ---
const MOB_DATA_URL = 'path/to/mob_data.json'; // 実際にはプロジェクト内のJSONパス
const EXPANSION_MAP = {
    'ARR': '新生エオルゼア',
    'HW': '蒼天のイシュガルド',
    'SB': '紅蓮のリベレーター',
    'SHB': '漆黒のヴィランズ',
    'EW': '暁月のフィナーレ',
    'DT': '黄金のレガシー'
};
const RANK_CONFIG = {
    'S': { label: 'S', bg: 'bg-red-600', max: 7200, min: 4800 },
    'A': { label: 'A', bg: 'bg-yellow-500', max: 7200, min: 4800 },
    'F': { label: 'F', bg: 'bg-indigo-500', max: 14400, min: 10800 },
    'B-A': { label: 'A (B連)', bg: 'bg-yellow-500', max: 3600, min: 3000 },
    'B-F': { label: 'F (B連)', bg: 'bg-indigo-500', max: 3600, min: 3000 }
}; // コード内の利用状況から再定義
const FILTER_TO_DATA_RANK_MAP = {
    'S': 'S',
    'A': 'A',
    'F': 'F',
    'ALL': 'ALL'
};
// 関連する定数は、必要に応じてこのファイルに集約します。


// --- グローバル状態変数 ---
let userId = localStorage.getItem('user_uuid') || null;
let baseMobData = []; // 静的なモブデータ（JSONからロード）
let globalMobData = []; // LKTや湧き潰し情報がマージされた動的なモブデータ
let openMobCardNo = localStorage.getItem('openMobCardNo') ? parseInt(localStorage.getItem('openMobCardNo')) : null;

// フィルタ状態 (LocalStorageから復元される前提)
let currentFilter = {
    rank: localStorage.getItem('filter_rank') || 'ALL',
    name: localStorage.getItem('filter_name') || '',
    // LocalStorageから復元し、Setオブジェクトに変換する処理がDOMContentLoadedに存在する
    areaSets: {}, 
};


// --- データ操作ロジック ---

/**
 * 静的モブデータをロードし、グローバル変数に格納する。
 * @returns {Promise<void>}
 */
const fetchBaseMobData = async () => {
    try {
        // 実際のコードでは、このURLからデータを取得する
        // const response = await fetch(MOB_DATA_URL); 
        // const data = await response.json();
        
        // 仮のデータ構造 (実際のデータ構造に合わせる)
        const mockData = [
            { No: 1, Name: "Sモブ・ネーム", Rank: "S", Area: "クルザス西部高地", Expansion: "HW", REPOP_s: 6600, Condition: "気象条件：霊風" },
            { No: 2, Name: "Aモブ・ネーム", Rank: "A", Area: "アバラシア雲海", Expansion: "HW", REPOP_s: 4800, Condition: "なし" },
            { No: 3, Name: "Fモブ・ネーム", Rank: "F", Area: "ギラバニア辺境", Expansion: "SB", REPOP_s: 12600, Condition: "なし" },
        ];
        
        baseMobData = mockData;
        
        // 動的データマージを可能にするため、基本データを複製
        globalMobData = baseMobData.map(mob => ({
            ...mob,
            last_kill_time: 0,
            prev_kill_time: 0,
            last_kill_memo: '',
            spawn_cull_status: {},
            // repopInfoは、LKTマージ後に再計算される
        }));

        displayStatus("モブ基本データロード完了。", 'success');

    } catch (error) {
        displayStatus(`モブ基本データロードエラー: ${error.message}`, 'error');
        console.error("Mob Data Load Error:", error);
    }
};

/**
 * Firestoreから取得したLKT/MemoデータをglobalMobDataにマージする。（機能群1から移動）
 * @param {object} mobStatusDataMap - Firestoreから取得したモブステータスデータ
 */
const mergeMobStatusData = (mobStatusDataMap) => {
    const newData = new Map();
    // 取得したデータをフラットなMapに変換
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

    // globalMobDataにマージ
    globalMobData = globalMobData.map(mob => {
        let mergedMob = { ...mob };
        if (newData.has(mob.No)) {
            const dynamicData = newData.get(mob.No);
            mergedMob.last_kill_time = dynamicData.last_kill_time;
            mergedMob.prev_kill_time = dynamicData.prev_kill_time;
            mergedMob.last_kill_memo = dynamicData.last_kill_memo;
        }
        // Repop計算（機能群3の関数に依存）
        mergedMob.repopInfo = calculateRepop(mergedMob); 
        return mergedMob;
    });
    
    // UI更新（機能群5の関数に依存）
    sortAndRedistribute();
};

/**
 * Firestoreから取得した湧き潰しデータをglobalMobDataにマージする。（機能群1から移動）
 * @param {object} locationsMap - Firestoreから取得した湧き潰しデータ
 */
const mergeMobLocationsData = (locationsMap) => {
    // globalMobDataにマージ
    globalMobData = globalMobData.map(mob => {
        let mergedMob = { ...mob };
        const dynamicData = locationsMap[mob.No];
        if (mob.Rank === 'S' && dynamicData) {
            // spawn_cull_status の構造が外部から提供されると仮定
            mergedMob.spawn_cull_status = dynamicData.points;
        }
        // Repop計算（機能群3の関数に依存）
        mergedMob.repopInfo = calculateRepop(mergedMob); 
        return mergedMob;
    });
    
    // UI更新（機能群5の関数に依存）
    sortAndRedistribute();
};

/**
 * フィルタの状態をLocalStorageに保存する。（機能群5から移動）
 */
const saveFilterState = () => {
    try {
        localStorage.setItem('filter_rank', currentFilter.rank);
        localStorage.setItem('filter_name', currentFilter.name);
        
        // SetをArrayに変換して保存
        const serializableAreaSets = {};
        for (const rank in currentFilter.areaSets) {
            if (currentFilter.areaSets[rank] instanceof Set) {
                serializableAreaSets[rank] = Array.from(currentFilter.areaSets[rank]);
            }
        }
        localStorage.setItem('filter_area_sets', JSON.stringify(serializableAreaSets));
        
    } catch (e) {
        console.warn("Could not save filter state to localStorage:", e);
    }
};

// フィルタ状態のロード処理はDOMContentLoadedブロック（機能群5）に移動。
