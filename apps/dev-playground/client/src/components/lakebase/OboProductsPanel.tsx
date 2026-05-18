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
import { Loader2, Package, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import { useLakebaseData, useLakebasePost } from "@/hooks/use-lakebase-data";

interface Product {
  id: string;
  name: string;
  category: string;
  price: number | string;
  stock: number;
  created_by: string | null;
  created_at: string;
}

interface CreateProductRequest {
  name: string;
  category: string;
  price: number;
  stock: number;
}

export function OboProductsPanel() {
  const nameId = useId();
  const categoryId = useId();
  const priceId = useId();
  const stockId = useId();

  const {
    data: myProducts,
    loading: myLoading,
    error: myError,
    refetch: refetchMy,
  } = useLakebaseData<Product[]>("/api/lakebase-examples/raw/my-products");

  const {
    data: allProducts,
    loading: allLoading,
    error: allError,
    refetch: refetchAll,
  } = useLakebaseData<Product[]>("/api/lakebase-examples/raw/products");

  const { post, loading: creating } = useLakebasePost<
    CreateProductRequest,
    Product
  >("/api/lakebase-examples/raw/my-products");

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
      refetchMy();
      refetchAll();
    }
  };

  const myProductsList = myProducts ?? [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card className="border-2 border-amber-200">
        <CardHeader className="pb-0 gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-100 rounded-lg flex-shrink-0 self-start">
              <ShieldCheck className="h-6 w-6 text-amber-600" />
            </div>
            <div className="flex-1 min-w-0">
              <CardTitle>Raw Driver — On-Behalf-Of (OBO)</CardTitle>
              <CardDescription>
                Per-user connection pool with Row-Level Security (RLS). Each
                user gets their own pg.Pool authenticated with their Databricks
                identity. The database filters rows based on{" "}
                <code>current_user</code>.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Create product as user */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Create Product (as current user)
          </CardTitle>
          <CardDescription>
            This product will have <code>created_by</code> set to your identity.
            RLS will make it visible only to you.
          </CardDescription>
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
                "Create Product (OBO)"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Side-by-side comparison */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* My products (OBO, RLS filtered) */}
        <Card className="border-amber-200">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">
                  My Products (OBO pool)
                </CardTitle>
                <CardDescription>
                  RLS-filtered via per-user pool. Users with{" "}
                  <code>databricks_superuser</code> role bypass RLS.
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => refetchMy()}>
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {myLoading && (
              <div className="flex items-center gap-2 text-warning py-4">
                <div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
                Loading...
              </div>
            )}
            {myError && (
              <div className="text-destructive bg-destructive/10 p-3 rounded-md border border-destructive/20">
                {myError.message}
              </div>
            )}
            {!myLoading && myProductsList.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No products yet. Create one above.</p>
              </div>
            )}
            {myProductsList.length > 0 && (
              <ProductTable products={myProductsList} showCreatedBy />
            )}
          </CardContent>
        </Card>

        {/* All products (SP, bypasses RLS) */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">
                  All Products (SP pool)
                </CardTitle>
                <CardDescription>
                  Service principal bypasses RLS
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => refetchAll()}>
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {allLoading && (
              <div className="flex items-center gap-2 text-warning py-4">
                <div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
                Loading...
              </div>
            )}
            {allError && (
              <div className="text-destructive bg-destructive/10 p-3 rounded-md border border-destructive/20">
                {allError.message}
              </div>
            )}
            {allProducts && allProducts.length > 0 && (
              <ProductTable products={allProducts} showCreatedBy />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ProductTable({
  products,
  showCreatedBy,
}: {
  products: Product[];
  showCreatedBy?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b">
            <th className="text-left py-2 px-2 font-medium text-muted-foreground">
              Name
            </th>
            <th className="text-left py-2 px-2 font-medium text-muted-foreground">
              Category
            </th>
            <th className="text-right py-2 px-2 font-medium text-muted-foreground">
              Price
            </th>
            {showCreatedBy && (
              <th className="text-left py-2 px-2 font-medium text-muted-foreground">
                Created By
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id} className="border-b last:border-0">
              <td className="py-2 px-2 font-medium">{p.name}</td>
              <td className="py-2 px-2">
                <Badge variant="outline">{p.category}</Badge>
              </td>
              <td className="py-2 px-2 text-right">
                ${Number(p.price).toFixed(2)}
              </td>
              {showCreatedBy && (
                <td className="py-2 px-2 text-xs text-muted-foreground">
                  {p.created_by ?? "—"}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
