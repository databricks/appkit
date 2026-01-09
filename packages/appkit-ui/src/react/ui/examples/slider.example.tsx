import { cn, Slider } from "@databricks/appkit-ui/react"

type SliderProps = React.ComponentProps<typeof Slider>

export default function SliderExample({ className, ...props }: SliderProps) {
  return (
    <Slider
      defaultValue={[50]}
      max={100}
      step={1}
      className={cn("w-[60%]", className)}
      {...props}
    />
  )
}
