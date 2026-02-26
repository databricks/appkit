import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@databricks/appkit-ui/react";
import {
  CheckCircle,
  Circle,
  Loader2,
  Package,
  ShoppingCart,
  Truck,
} from "lucide-react";
import { useId, useState } from "react";
import {
  useLakebaseData,
  useLakebasePatch,
  useLakebasePost,
} from "@/hooks/use-lakebase-data";

interface Order {
  id: number;
  orderNumber: string;
  customerName: string;
  productName: string;
  amount: number;
  status: "pending" | "processing" | "shipped" | "delivered";
  createdAt: string;
  updatedAt: string;
}

interface OrderStats {
  total: number;
  pending: number;
  processing: number;
  shipped: number;
  delivered: number;
}

export function OrdersPanel() {
  const orderNumberId = useId();
  const customerNameId = useId();
  const productNameId = useId();
  const amountId = useId();

  const {
    data: orders,
    loading: ordersLoading,
    error: ordersError,
    refetch,
  } = useLakebaseData<Order[]>("/api/lakebase-examples/sequelize/orders");

  const { data: stats } = useLakebaseData<OrderStats>(
    "/api/lakebase-examples/sequelize/stats",
  );

  const { post, loading: creating } = useLakebasePost<Partial<Order>, Order>(
    "/api/lakebase-examples/sequelize/orders",
  );

  const { patch, loading: updating } = useLakebasePatch<
    { status: string },
    Order
  >("/api/lakebase-examples/sequelize/orders");

  const generateRandomOrder = () => {
    const customers = [
      "Alice Johnson",
      "Bob Smith",
      "Carol Williams",
      "David Brown",
      "Emma Davis",
      "Frank Miller",
      "Grace Wilson",
      "Henry Moore",
    ];
    const products = [
      "Wireless Bluetooth Headphones",
      "USB-C Charging Cable",
      "Laptop Stand - Ergonomic",
      "Mechanical Keyboard - RGB",
      "4K Webcam with Microphone",
      "Portable SSD 1TB",
      "Wireless Mouse - Ergonomic",
      "Monitor Arm Mount",
      "Noise Cancelling Earbuds",
      "Desk Lamp - LED",
    ];

    const orderNum = `ORD-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9999) + 1).padStart(4, "0")}`;
    const customer = customers[Math.floor(Math.random() * customers.length)];
    const product = products[Math.floor(Math.random() * products.length)];
    const amount = (Math.random() * 200 + 10).toFixed(2);

    return {
      orderNumber: orderNum,
      customerName: customer,
      productName: product,
      amount,
    };
  };

  const [formData, setFormData] = useState(generateRandomOrder());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await post({
      orderNumber: formData.orderNumber,
      customerName: formData.customerName,
      productName: formData.productName,
      amount: Number.parseFloat(formData.amount),
      status: "pending",
    });

    if (result) {
      setFormData(generateRandomOrder());
      refetch();
    }
  };

  const handleStatusUpdate = async (id: number, status: Order["status"]) => {
    const result = await patch(id, { status });
    if (result) {
      refetch();
    }
  };

  const getStatusBadge = (status: Order["status"]) => {
    switch (status) {
      case "pending":
        return (
          <Badge className="bg-gray-100 text-gray-700 border-gray-200">
            <Circle className="w-3 h-3 mr-1" />
            Pending
          </Badge>
        );
      case "processing":
        return (
          <Badge className="bg-blue-100 text-blue-700 border-blue-200">
            <Package className="w-3 h-3 mr-1" />
            Processing
          </Badge>
        );
      case "shipped":
        return (
          <Badge className="bg-purple-100 text-purple-700 border-purple-200">
            <Truck className="w-3 h-3 mr-1" />
            Shipped
          </Badge>
        );
      case "delivered":
        return (
          <Badge className="bg-green-100 text-green-700 border-green-200">
            <CheckCircle className="w-3 h-3 mr-1" />
            Delivered
          </Badge>
        );
    }
  };

  const ordersByStatus = orders
    ? {
        pending: orders.filter((o) => o.status === "pending"),
        processing: orders.filter((o) => o.status === "processing"),
        shipped: orders.filter((o) => o.status === "shipped"),
        delivered: orders.filter((o) => o.status === "delivered"),
      }
    : { pending: [], processing: [], shipped: [], delivered: [] };

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card className="border-2">
        <CardHeader className="pb-0 gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-orange-100 rounded-lg flex-shrink-0 self-start">
              <ShoppingCart className="h-6 w-6 text-orange-600" />
            </div>
            <div className="flex-1 min-w-0">
              <CardTitle>Sequelize Example</CardTitle>
              <CardDescription>
                Model-based ORM with intuitive API and automatic timestamps
              </CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Statistics */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <Card>
            <CardHeader className="pb-3">
              <CardDescription className="text-xs">
                Total Orders
              </CardDescription>
              <CardTitle className="text-2xl">{stats.total}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardDescription className="text-xs">Pending</CardDescription>
              <CardTitle className="text-2xl">{stats.pending}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardDescription className="text-xs">Processing</CardDescription>
              <CardTitle className="text-2xl">{stats.processing}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardDescription className="text-xs">Shipped</CardDescription>
              <CardTitle className="text-2xl">{stats.shipped}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardDescription className="text-xs">Delivered</CardDescription>
              <CardTitle className="text-2xl">{stats.delivered}</CardTitle>
            </CardHeader>
          </Card>
        </div>
      )}

      {/* Create order form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Create Order</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor={orderNumberId}
                  className="text-sm font-medium mb-1 block"
                >
                  Order Number
                </label>
                <Input
                  id={orderNumberId}
                  value={formData.orderNumber}
                  onChange={(e) =>
                    setFormData({ ...formData, orderNumber: e.target.value })
                  }
                  placeholder="ORD-2024-0001"
                  required
                />
              </div>
              <div>
                <label
                  htmlFor={customerNameId}
                  className="text-sm font-medium mb-1 block"
                >
                  Customer Name
                </label>
                <Input
                  id={customerNameId}
                  value={formData.customerName}
                  onChange={(e) =>
                    setFormData({ ...formData, customerName: e.target.value })
                  }
                  placeholder="John Doe"
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor={productNameId}
                  className="text-sm font-medium mb-1 block"
                >
                  Product Name
                </label>
                <Input
                  id={productNameId}
                  value={formData.productName}
                  onChange={(e) =>
                    setFormData({ ...formData, productName: e.target.value })
                  }
                  placeholder="Wireless Headphones"
                  required
                />
              </div>
              <div>
                <label
                  htmlFor={amountId}
                  className="text-sm font-medium mb-1 block"
                >
                  Amount ($)
                </label>
                <Input
                  id={amountId}
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.amount}
                  onChange={(e) =>
                    setFormData({ ...formData, amount: e.target.value })
                  }
                  placeholder="99.99"
                  required
                />
              </div>
            </div>
            <Button type="submit" disabled={creating} className="w-full">
              {creating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Order"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Order board */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Order Board</CardTitle>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {ordersLoading && (
            <div className="flex items-center gap-2 text-warning py-8">
              <div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
              Loading orders...
            </div>
          )}

          {ordersError && (
            <div className="text-destructive bg-destructive/10 p-3 rounded-md border border-destructive/20">
              <span className="font-semibold">Error:</span>{" "}
              {ordersError.message}
            </div>
          )}

          {orders && orders.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <ShoppingCart className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p>No orders yet. Add an order to get started.</p>
            </div>
          )}

          {orders && orders.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              {/* Pending column */}
              <div className="space-y-3">
                <div className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                  Pending ({ordersByStatus.pending.length})
                </div>
                <div className="space-y-2">
                  {ordersByStatus.pending.map((order) => (
                    <Card key={order.id} className="p-3">
                      <div className="space-y-2">
                        <div>{getStatusBadge(order.status)}</div>
                        <h4 className="font-medium text-sm">
                          {order.orderNumber}
                        </h4>
                        <p className="text-xs text-muted-foreground">
                          {order.customerName}
                        </p>
                        <p className="text-xs font-medium">
                          {order.productName}
                        </p>
                        <p className="text-sm font-bold text-green-600">
                          ${Number(order.amount).toFixed(2)}
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full"
                          onClick={() =>
                            handleStatusUpdate(order.id, "processing")
                          }
                          disabled={updating}
                        >
                          Process
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>

              {/* Processing column */}
              <div className="space-y-3">
                <div className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                  Processing ({ordersByStatus.processing.length})
                </div>
                <div className="space-y-2">
                  {ordersByStatus.processing.map((order) => (
                    <Card key={order.id} className="p-3">
                      <div className="space-y-2">
                        <div>{getStatusBadge(order.status)}</div>
                        <h4 className="font-medium text-sm">
                          {order.orderNumber}
                        </h4>
                        <p className="text-xs text-muted-foreground">
                          {order.customerName}
                        </p>
                        <p className="text-xs font-medium">
                          {order.productName}
                        </p>
                        <p className="text-sm font-bold text-green-600">
                          ${Number(order.amount).toFixed(2)}
                        </p>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="flex-1"
                            onClick={() =>
                              handleStatusUpdate(order.id, "pending")
                            }
                            disabled={updating}
                          >
                            Back
                          </Button>
                          <Button
                            size="sm"
                            className="flex-1"
                            onClick={() =>
                              handleStatusUpdate(order.id, "shipped")
                            }
                            disabled={updating}
                          >
                            Ship
                          </Button>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>

              {/* Shipped column */}
              <div className="space-y-3">
                <div className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                  Shipped ({ordersByStatus.shipped.length})
                </div>
                <div className="space-y-2">
                  {ordersByStatus.shipped.map((order) => (
                    <Card key={order.id} className="p-3">
                      <div className="space-y-2">
                        <div>{getStatusBadge(order.status)}</div>
                        <h4 className="font-medium text-sm">
                          {order.orderNumber}
                        </h4>
                        <p className="text-xs text-muted-foreground">
                          {order.customerName}
                        </p>
                        <p className="text-xs font-medium">
                          {order.productName}
                        </p>
                        <p className="text-sm font-bold text-green-600">
                          ${Number(order.amount).toFixed(2)}
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full"
                          onClick={() =>
                            handleStatusUpdate(order.id, "delivered")
                          }
                          disabled={updating}
                        >
                          Deliver
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>

              {/* Delivered column */}
              <div className="space-y-3">
                <div className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                  Delivered ({ordersByStatus.delivered.length})
                </div>
                <div className="space-y-2">
                  {ordersByStatus.delivered.map((order) => (
                    <Card key={order.id} className="p-3 opacity-75">
                      <div className="space-y-2">
                        <div>{getStatusBadge(order.status)}</div>
                        <h4 className="font-medium text-sm">
                          {order.orderNumber}
                        </h4>
                        <p className="text-xs text-muted-foreground">
                          {order.customerName}
                        </p>
                        <p className="text-xs font-medium">
                          {order.productName}
                        </p>
                        <p className="text-sm font-bold text-green-600">
                          ${Number(order.amount).toFixed(2)}
                        </p>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
