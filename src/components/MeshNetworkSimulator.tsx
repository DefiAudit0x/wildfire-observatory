import { useState, useEffect } from "react";
import { Bluetooth, Radio, WifiOff, Send, Smartphone, Activity, AlertTriangle, ShieldCheck } from "lucide-react";

interface Node {
  id: string;
  name: string;
  signalStrength: number; // 0 to 100
  status: "connected" | "connecting" | "disconnected";
  battery: number;
}

interface Message {
  id: string;
  sender: string;
  content: string;
  timestamp: Date;
  hops: number;
  status: "sending" | "delivered" | "failed";
}

interface MeshNetworkSimulatorProps {
  lang: "ar" | "fr";
}

export default function MeshNetworkSimulator({ lang }: MeshNetworkSimulatorProps) {
  const isArabic = lang === "ar";
  const [isAdvertising, setIsAdvertising] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState("");

  const myNodeId = "MY_NODE_" + Math.floor(Math.random() * 1000);

  // Simulate discovering nodes
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isDiscovering) {
      interval = setInterval(() => {
        if (Math.random() > 0.6 && nodes.length < 5) {
          const newNode: Node = {
            id: `NODE_${Math.floor(Math.random() * 10000)}`,
            name: `Citizen_${Math.floor(Math.random() * 100)}`,
            signalStrength: Math.floor(Math.random() * 60) + 40,
            status: "connected",
            battery: Math.floor(Math.random() * 80) + 20,
          };
          setNodes((prev) => [...prev, newNode]);
        }
      }, 3000);
    }
    return () => clearInterval(interval);
  }, [isDiscovering, nodes.length]);

  // Simulate incoming messages via mesh
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isAdvertising && isDiscovering && nodes.length > 0) {
      interval = setInterval(() => {
        if (Math.random() > 0.8) {
          const randomNode = nodes[Math.floor(Math.random() * nodes.length)];
          const incomingMsg: Message = {
            id: `MSG_${Date.now()}`,
            sender: randomNode.name,
            content: "🔥 حريق جديد مرصود بالقرب من موقعي! أحتاج مساعدة.",
            timestamp: new Date(),
            hops: Math.floor(Math.random() * 4) + 1,
            status: "delivered",
          };
          setMessages((prev) => [incomingMsg, ...prev]);
        }
      }, 8000);
    }
    return () => clearInterval(interval);
  }, [isAdvertising, isDiscovering, nodes]);

  const handleSendMessage = () => {
    if (!newMessage.trim()) return;
    
    const msg: Message = {
      id: `MSG_${Date.now()}`,
      sender: isArabic ? "أنا" : "Moi",
      content: newMessage,
      timestamp: new Date(),
      hops: 0,
      status: "sending",
    };
    
    setMessages((prev) => [msg, ...prev]);
    setNewMessage("");

    // Simulate multi-hop routing delay
    setTimeout(() => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id ? { ...m, status: nodes.length > 0 ? "delivered" : "failed", hops: Math.floor(Math.random() * 3) + 1 } : m
        )
      );
    }, 2000);
  };

  const toggleMesh = () => {
    if (!isAdvertising) {
      setIsAdvertising(true);
      setIsDiscovering(true);
    } else {
      setIsAdvertising(false);
      setIsDiscovering(false);
      setNodes([]);
    }
  };

  return (
    <div className="bg-zinc-900/60 border border-indigo-500/10 rounded-xl p-5 shadow-2xl font-sans text-slate-200">
      <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-white/5 pb-4 mb-5 gap-3">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${isAdvertising ? 'bg-indigo-500/20 text-indigo-400' : 'bg-slate-800 text-slate-500'}`}>
            {isAdvertising ? <Activity className="h-6 w-6 animate-pulse" /> : <WifiOff className="h-6 w-6" />}
          </div>
          <div>
            <h3 className="font-bold text-lg text-slate-100 flex items-center gap-2">
              <span>{isArabic ? "شبكة Mesh للاتصال الميداني (بدون إنترنت)" : "Réseau Mesh Tactique (Hors-ligne)"}</span>
              <span className="text-[10px] bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-1.5 py-0.5 rounded font-mono">Nearby Connections API</span>
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              {isArabic 
                ? "محاكاة ربط الهواتف الذكية عبر البلوتوث و Wi-Fi Direct لتبادل بلاغات الحريق حين ينقطع الإرسال الخلوي." 
                : "Simulation de routage de messages via Bluetooth/Wi-Fi Direct en cas de coupure réseau."}
            </p>
          </div>
        </div>

        <button
          onClick={toggleMesh}
          className={`px-4 py-2 rounded-lg font-bold text-sm transition-all shadow-lg flex items-center gap-2 ${
            isAdvertising 
              ? "bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30" 
              : "bg-indigo-600 hover:bg-indigo-500 text-white border border-indigo-400"
          }`}
        >
          {isAdvertising ? (
            <>
              <WifiOff className="h-4 w-4" />
              <span>{isArabic ? "إيقاف الشبكة" : "Désactiver Mesh"}</span>
            </>
          ) : (
            <>
              <Bluetooth className="h-4 w-4" />
              <span>{isArabic ? "تفعيل نقطة الاتصال Mesh" : "Activer Nœud Mesh"}</span>
            </>
          )}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Nodes / Topology Panel */}
        <div className="lg:col-span-1 bg-black/40 border border-white/5 rounded-xl p-4 flex flex-col min-h-[300px]">
          <h4 className="text-sm font-bold text-slate-300 flex items-center gap-2 mb-4">
            <Radio className="h-4 w-4 text-indigo-400" />
            <span>{isArabic ? "الأجهزة القريبة المرتبطة (Topology)" : "Nœuds Connectés (Topologie)"}</span>
          </h4>
          
          <div className="flex-1 space-y-3 overflow-y-auto pr-1 custom-scrollbar">
            {!isAdvertising ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-2 opacity-50">
                <WifiOff className="h-10 w-10" />
                <p className="text-xs text-center">{isArabic ? "الشبكة غير مفعلة. قم بتفعيلها للبحث عن أجهزة." : "Réseau inactif."}</p>
              </div>
            ) : nodes.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-indigo-400/60 gap-3">
                <div className="relative flex items-center justify-center h-12 w-12">
                  <div className="absolute h-full w-full rounded-full border-2 border-indigo-500 opacity-20 animate-ping"></div>
                  <Bluetooth className="h-6 w-6 animate-pulse" />
                </div>
                <p className="text-xs text-center">{isArabic ? "جاري البحث عن هواتف قريبة..." : "Recherche de téléphones à proximité..."}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {/* My Node */}
                <div className="bg-indigo-950/40 border border-indigo-500/30 p-2.5 rounded-lg flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Smartphone className="h-4 w-4 text-indigo-400" />
                    <div>
                      <p className="text-xs font-bold text-indigo-200">{isArabic ? "هاتفي (نقطة ارتكاز)" : "Mon Appareil"}</p>
                      <p className="text-[10px] text-indigo-400/70 font-mono">{myNodeId}</p>
                    </div>
                  </div>
                  <ShieldCheck className="h-4 w-4 text-emerald-400" />
                </div>

                {/* Peer Nodes */}
                {nodes.map((node) => (
                  <div key={node.id} className="bg-zinc-800/50 border border-white/5 p-2.5 rounded-lg flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Smartphone className="h-4 w-4 text-slate-400" />
                      <div>
                        <p className="text-xs font-bold text-slate-200">{node.name}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[9px] text-slate-400 bg-slate-900 px-1 rounded border border-slate-700">
                            {node.signalStrength}% Signal
                          </span>
                          <span className="text-[9px] text-emerald-400 bg-emerald-950 px-1 rounded border border-emerald-900">
                            {node.battery}% Batt
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_5px_#10b981]"></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Messaging Panel */}
        <div className="lg:col-span-2 bg-black/40 border border-white/5 rounded-xl p-4 flex flex-col h-[400px]">
          <h4 className="text-sm font-bold text-slate-300 flex items-center gap-2 mb-4">
            <Send className="h-4 w-4 text-sky-400" />
            <span>{isArabic ? "سجل الرسائل المشفرة (P2P Routing)" : "Journal des Messages P2P"}</span>
          </h4>

          <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar mb-4 flex flex-col-reverse">
            {messages.length === 0 ? (
              <div className="m-auto text-slate-500 text-xs flex flex-col items-center gap-2 opacity-60">
                <Radio className="h-8 w-8" />
                <p>{isArabic ? "لا توجد رسائل في النطاق حالياً." : "Aucun message dans la zone."}</p>
              </div>
            ) : (
              messages.map((msg) => (
                <div 
                  key={msg.id} 
                  className={`p-3 rounded-xl max-w-[85%] ${
                    msg.sender === (isArabic ? "أنا" : "Moi") 
                      ? "bg-indigo-600/20 border border-indigo-500/30 self-end rounded-tr-sm" 
                      : "bg-slate-800 border border-slate-700 self-start rounded-tl-sm"
                  }`}
                >
                  <div className="flex items-center justify-between gap-4 mb-1">
                    <span className="text-xs font-bold text-slate-200">{msg.sender}</span>
                    <span className="text-[9px] text-slate-400 font-mono">{msg.timestamp.toLocaleTimeString()}</span>
                  </div>
                  <p className="text-sm text-slate-100">{msg.content}</p>
                  
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5">
                    <span className="text-[9px] text-slate-400 flex items-center gap-1">
                      <Radio className="h-3 w-3" />
                      {msg.hops} {isArabic ? "قفزات (Hops)" : "Sauts (Hops)"}
                    </span>
                    <span className={`text-[9px] font-bold ${
                      msg.status === "delivered" ? "text-emerald-400" : msg.status === "failed" ? "text-red-400" : "text-amber-400"
                    }`}>
                      {msg.status === "delivered" 
                        ? (isArabic ? "تم الإيصال" : "Délivré") 
                        : msg.status === "failed" 
                          ? (isArabic ? "فشل الإرسال" : "Échec")
                          : (isArabic ? "جاري الإرسال..." : "Envoi...")}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="relative mt-auto">
            <input
              type="text"
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
              disabled={!isAdvertising}
              placeholder={isArabic ? "اكتب رسالة طوارئ للشبكة المحلية..." : "Message d'urgence local..."}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-4 pr-12 py-3 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
              dir={isArabic ? "rtl" : "ltr"}
            />
            <button
              onClick={handleSendMessage}
              disabled={!isAdvertising || !newMessage.trim()}
              className="absolute top-1/2 -translate-y-1/2 rtl:left-2 ltr:right-2 p-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send className="h-4 w-4 rtl:rotate-180" />
            </button>
          </div>
          {!isAdvertising && (
            <p className="text-[10px] text-red-400 mt-2 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {isArabic ? "قم بتفعيل شبكة Mesh لإرسال واستقبال البلاغات دون إنترنت." : "Activez le réseau Mesh pour envoyer hors-ligne."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
