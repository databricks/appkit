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
import { Database, Loader2, Package } from "lucide-react";
import { useId, useState } from "react";
import { useLakebaseData, useLakebasePost } from "@/hooks/use-lakebase-data";

interface Product {
  id: number;
  name: string;
  category: string;
  price: number | string; // PostgreSQL DECIMAL returns as string
  stock: number;
  created_by?: string;
  created_at: string;
}

interface CreateProductRequest {
  name: string;
  category: string;
  price: number;
  stock: number;
}

interface HealthStatus {
  status: string;
  connected: boolean;
  message: string;
}

export function ProductsPanel() {
  const nameId = useId();
  const categoryId = useId();
  const priceId = useId();
  const stockId = useId();

  const {
    data: products,
    loading: productsLoading,
    error: productsError,
    refetch,
  } = useLakebaseData<Product[]>("/api/lakebase-examples/raw/products");

  const { data: health } = useLakebaseData<HealthStatus>(
    "/api/lakebase-examples/raw/health",
  );

  const { post, loading: creating } = useLakebasePost<
    CreateProductRequest,
    Product
  >("/api/lakebase-examples/raw/products");

  const generateRandomProduct = () => {
    const products = [
      "Ergonomic Keyboard",
      "Wireless Mouse",
      "USB-C Hub",
      "Laptop Stand",
      "Monitor Arm",
      "Mechanical Keyboard",
      "Gaming Headset",
      "Webcam HD",
    ];
    const categories = ["Electronics", "Accessories", "Peripherals", "Office"];
    const price = (Math.random() * (199.99 - 29.99) + 29.99).toFixed(2);
    const stock = Math.floor(Math.random() * (500 - 50) + 50);

    return {
      name: products[Math.floor(Math.random() * products.length)],
      category: categories[Math.floor(Math.random() * categories.length)],
      price,
      stock: String(stock),
    };
  };

  const [formData, setFormData] = useState(generateRandomProduct());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await post({
      name: formData.name,
      category: formData.category,
      price: Number(formData.price),
      stock: Number(formData.stock),
    });

    if (result) {
      setFormData(generateRandomProduct());
      refetch();
    }
  };

  return (
    <div className="space-y-4">
      {/* Header with connection status */}
      <Card className="border-2">
        <CardHeader className="pb-0 gap-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg flex-shrink-0 self-start">
                <Database className="h-6 w-6 text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <CardTitle>Raw Driver Example</CardTitle>
                <CardDescription>
                  Direct PostgreSQL connection using pg.Pool with automatic
                  OAuth token refresh
                </CardDescription>
              </div>
            </div>
            {health && (
              <Badge
                className={`${
                  health.connected
                    ? "bg-green-100 text-green-700 border-green-200"
                    : "bg-red-100 text-red-700 border-red-200"
                }`}
              >
                {health.connected ? "Connected" : "Disconnected"}
              </Badge>
            )}
          </div>
        </CardHeader>
      </Card>

      {/* Create product form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Create Product</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor={nameId}
                  className="text-sm font-medium mb-1 block"
                >
                  Product Name
                </label>
                <Input
                  id={nameId}
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  placeholder="Wireless Mouse"
                  required
                />
              </div>
              <div>
                <label
                  htmlFor={categoryId}
                  className="text-sm font-medium mb-1 block"
                >
                  Category
                </label>
                <Input
                  id={categoryId}
                  value={formData.category}
                  onChange={(e) =>
                    setFormData({ ...formData, category: e.target.value })
                  }
                  placeholder="Electronics"
                  required
                />
              </div>
              <div>
                <label
                  htmlFor={priceId}
                  className="text-sm font-medium mb-1 block"
                >
                  Price
                </label>
                <Input
                  id={priceId}
                  type="number"
                  step="0.01"
                  value={formData.price}
                  onChange={(e) =>
                    setFormData({ ...formData, price: e.target.value })
                  }
                  placeholder="29.99"
                  required
                />
              </div>
              <div>
                <label
                  htmlFor={stockId}
                  className="text-sm font-medium mb-1 block"
                >
                  Stock
                </label>
                <Input
                  id={stockId}
                  type="number"
                  value={formData.stock}
                  onChange={(e) =>
                    setFormData({ ...formData, stock: e.target.value })
                  }
                  placeholder="100"
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
                "Create Product"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Products list */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Products Catalog</CardTitle>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {productsLoading && (
            <div className="flex items-center gap-2 text-warning py-8">
              <div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
              Loading products...
            </div>
          )}

          {productsError && (
            <div className="text-destructive bg-destructive/10 p-3 rounded-md border border-destructive/20">
              <span className="font-semibold">Error:</span>{" "}
              {productsError.message}
            </div>
          )}

          {products && products.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Package className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p>No products available. Create your first product above.</p>
            </div>
          )}

          {products && products.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 px-4 text-sm font-medium text-muted-foreground">
                      ID
                    </th>
                    <th className="text-left py-2 px-4 text-sm font-medium text-muted-foreground">
                      Name
                    </th>
                    <th className="text-left py-2 px-4 text-sm font-medium text-muted-foreground">
                      Category
                    </th>
                    <th className="text-right py-2 px-4 text-sm font-medium text-muted-foreground">
                      Price
                    </th>
                    <th className="text-right py-2 px-4 text-sm font-medium text-muted-foreground">
                      Stock
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product) => (
                    <tr key={product.id} className="border-b last:border-0">
                      <td className="py-3 px-4 text-sm">{product.id}</td>
                      <td className="py-3 px-4 font-medium">{product.name}</td>
                      <td className="py-3 px-4 text-sm">
                        <Badge variant="outline">{product.category}</Badge>
                      </td>
                      <td className="py-3 px-4 text-sm text-right">
                        ${Number(product.price).toFixed(2)}
                      </td>
                      <td className="py-3 px-4 text-sm text-right">
                        {product.stock}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
