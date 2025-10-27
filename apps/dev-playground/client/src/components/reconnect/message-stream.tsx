import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

interface Message {
  count: number;
  total: number;
  content: string;
  timestamp: string;
}

interface MessageStreamProps {
  messages: Message[];
}

export function MessageStream({ messages }: MessageStreamProps) {
  return (
    <Card className="p-6 h-full">
      <h3 className="text-xl font-semibold mb-4">Message Stream</h3>

      {messages.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p>Waiting for messages...</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 min-h-[400px] max-h-[400px] overflow-y-auto pr-2">
          {messages.map((msg, index) => (
            <div
              key={msg.timestamp}
              className="p-4 bg-gray-50 rounded border border-gray-200 animate-slideIn"
              style={{
                animation: `slideIn 0.3s ease-out ${index * 0.1}s both`,
              }}
            >
              <div className="flex items-center justify-between mb-2">
                <p className="font-semibold">
                  Message {msg.count}/{msg.total}
                </p>
                <div className="flex gap-2">
                  {msg.count === 2 && (
                    <Badge className="bg-yellow-100 text-yellow-700 border-yellow-200 hover:bg-yellow-100 hover:text-yellow-700">
                      Disconnect
                    </Badge>
                  )}
                  {msg.count === 3 && (
                    <Badge className="bg-green-100 text-green-700 border-green-200 hover:bg-green-100 hover:text-green-700">
                      Reconnected
                    </Badge>
                  )}
                </div>
              </div>
              <p className="text-sm text-gray-600">{msg.content}</p>
              <p className="text-xs text-gray-400 mt-2">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
